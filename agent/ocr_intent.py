"""Receipt extraction and mandatory ledger lookup before OCR billing decisions."""

import json
import logging
import re
import unicodedata
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from service_auth import backend_requests as requests

from data_retrieval import _read_backend, _time
from runtime_settings import backend_url


CURRENCIES = {"CNY": 100, "JPY": 101, "USD": 102}
MAX_CANDIDATES = 20
MATCH_SECONDS = 120
log = logging.getLogger("uvicorn.error.ocr_intent")


def text(value):
    return unicodedata.normalize("NFKC", str(value or "")).replace("\\n", "\n").strip()


def quoted(quote, source):
    quote = " ".join(text(quote).split())
    return bool(quote) and quote in " ".join(text(source).split())


def _receipt_layout(value):
    value = text(value)
    characters, positions = [], []
    for match in re.finditer(r"\s+|\S", value):
        start, end = match.span()
        character = match.group()
        if character.isspace():
            # Do not turn separate numbers, e.g. "9 92", into an invented amount.
            if not (start and end < len(value) and value[start - 1].isdigit() and value[end].isdigit()):
                continue
            character = " "
        characters.append(character)
        positions.append((start, end))
    return "".join(characters), positions


def _receipt_quote(quote, source):
    """Return a continuous source span, tolerating layout but not changed digits."""
    source = text(source)
    needle, _ = _receipt_layout(quote)
    haystack, positions = _receipt_layout(source)
    if not needle:
        return ""
    start = haystack.find(needle)
    while start >= 0:
        end = start + len(needle)
        left_number = needle[0].isdigit() and start > 0 and haystack[start - 1] in "0123456789.,"
        right_number = needle[-1].isdigit() and end < len(haystack) and haystack[end] in "0123456789.,"
        if not left_number and not right_number:
            return source[positions[start][0]:positions[end - 1][1]]
        start = haystack.find(needle, start + 1)
    return ""


def _amount_values(quote, currency):
    values = []
    for raw in re.findall(r"(?<!\d)\d[\d,.]*(?!\d)", text(quote)):
        raw = raw.rstrip(".,").replace(",", "")
        if currency == "JPY" and re.fullmatch(r"\d{1,3}(?:\.\d{3})+", raw):
            raw = raw.replace(".", "")
        try:
            values.append(Decimal(raw))
        except ArithmeticError:
            continue
    return values


def _recover_amount_quote(quote, source, amount, currency):
    """Recover a paid-total fragment from a joined quote, never from a bare number."""
    if not isinstance(quote, str) or amount not in _amount_values(quote, currency):
        return ""
    labels = ("合計", "総合計", "お支払金額", "お買上金額", "クレジット支払", "支払金額",
              "实付", "实付款", "实付金额", "实际支付", "支付金额", "付款金额", "实收金额",
              "Total", "Amount paid")
    label_pattern = "|".join(r"\s*".join(re.escape(c) for c in label if not c.isspace())
                             for label in sorted(labels, key=len, reverse=True))
    pattern = rf"(?:{label_pattern})\s*[:：]?\s*(?:[¥￥$＄]|US\$|JPY|CNY|RMB|USD)?\s*\d[\d,.]*"
    source = text(source)
    spans, values = [], set()
    for match in re.finditer(pattern, source, re.I):
        prefix = source[max(0, match.start() - 24):match.start()]
        suffix = source[match.end():match.end() + 16]
        if re.search(r"(?:小|税額|税额|割引|优惠|折扣|返金|退款|ポイント|点数|积分|sub|tax|discount)\s*$", prefix, re.I):
            continue
        if re.match(r"\s*(?:%|倍|ポイント|点|积分)", suffix):
            continue
        if match.start() and source[match.start() - 1].isascii() and source[match.start() - 1].isalnum():
            continue
        matched_values = _amount_values(match.group(), currency)
        if len(matched_values) == 1:
            values.update(matched_values)
            spans.append(match.group())
    # Split payments or conflicting totals require review, not a guessed excerpt.
    if values != {amount}:
        return ""
    return next((span for span in spans if _receipt_quote(span, quote)), "")


def uncertain(message, **fields):
    return {**fields, "image_intent": "uncertain", "needs_review": True,
            "matched_dealing": {"found": False, "DealingNumber": None},
            "confidence": 0.0, "reason": message}


def _model(phase, payload, source_id=None):
    from agent import run_ocr_intent_agent
    from tool import extract_json_from_agent_result, open_prompt

    answer = run_ocr_intent_agent(open_prompt(
        "ocr_intent", phase=phase, payload=json.dumps(payload, ensure_ascii=False),
    ), phase=phase, source_id=source_id)
    result = extract_json_from_agent_result(answer)
    if not isinstance(result, dict):
        raise ValueError("OCR judgment must be a JSON object")
    return result


def account_options():
    """Send account identities, never balances or unrelated ledger data, to the model."""
    try:
        response = requests.get(backend_url() + "/DB/accounts", timeout=30)
        response.raise_for_status()
        data = response.json()
        items = (data.get("result") or {}).get("items")
        if data.get("success") is not True or not isinstance(items, list):
            raise ValueError("Invalid account response")
        fields = ("account_number", "name", "account_type", "institution", "currency")
        options = []
        for item in items:
            if not isinstance(item, dict) or type(item.get("account_number")) is not int:
                raise ValueError("Invalid account identity")
            options.append({field: item.get(field) for field in fields})
        return options, True
    except (requests.RequestException, ValueError, TypeError, AttributeError):
        log.warning("OCR account lookup failed; preserve receipt without assigning an account")
        return [], False


def select_account(receipt, options, ocr_text, available=True):
    """A missing/unsafe account match must not invalidate an otherwise valid expense."""
    empty = {"account_number": None, "account_evidence": "", "account_match": "unmatched",
             "account_reason": "Payment account could not be confirmed"}
    if not available:
        return {**empty, "account_match": "unavailable", "account_reason": "Account lookup unavailable"}
    number = receipt.get("account_number")
    if number is None:
        return empty
    account = next((item for item in options if type(number) is int and item["account_number"] == number), None)
    if account is None:
        return {**empty, "account_reason": "Selected account is not in the supplied account list"}
    if account.get("currency") != receipt["currency"]:
        return {**empty, "account_reason": "Payment account currency differs from the receipt"}
    account_types = {"cash": {"cash"}, "credit_card": {"credit"},
                     "debit_card": {"bank"}, "ewallet": {"ewallet"}}
    allowed = account_types.get(receipt.get("payment_method"))
    if allowed is not None and account.get("account_type") not in allowed:
        return {**empty, "account_reason": "Account type conflicts with the payment method"}
    evidence = receipt.get("account_evidence")
    try:
        confident = 0.8 <= float(receipt.get("account_confidence", 0)) <= 1
    except (TypeError, ValueError):
        confident = False
    if not confident or not isinstance(evidence, str) or not quoted(evidence, ocr_text):
        return {**empty, "account_reason": "Account selection has insufficient OCR evidence or confidence"}
    return {"account_number": number, "account_evidence": text(evidence), "account_match": "matched",
            "account_reason": str(receipt.get("account_reason") or "Matched supplied account to payment evidence")}


def validate_receipt(data, ocr_text):
    """Verify source quotes and required transaction fields, not just model confidence."""
    currency = str(data.get("currency", "")).upper().replace("RMB", "CNY")
    amount = Decimal(str(data.get("amount")))
    if currency not in CURRENCIES or not amount.is_finite() or amount <= 0:
        raise ValueError("A positive amount and supported currency are required")
    quantum = Decimal("1") if currency == "JPY" else Decimal("0.01")
    if amount != amount.quantize(quantum):
        raise ValueError("Invalid currency precision")
    data = dict(data)
    repairs = {}
    for field in ("amount_evidence", "time_evidence"):
        original = data.get(field)
        resolved = _receipt_quote(original, ocr_text) if isinstance(original, str) else ""
        method = "layout_normalization"
        if not resolved and field == "amount_evidence":
            resolved = _recover_amount_quote(original, ocr_text, amount, currency)
            method = "source_paid_total"
        if not resolved:
            raise ValueError("Missing source quote: " + field)
        if resolved != text(original):
            repairs[field] = method
        data[field] = resolved
    if repairs:
        data["evidence_repairs"] = repairs
    else:
        data.pop("evidence_repairs", None)
    amount_quote = text(data["amount_evidence"])
    if re.search(r"ポイント|点数|倍|积分", amount_quote, re.I):
        raise ValueError("Points and promotions are not the paid total")
    if amount not in _amount_values(amount_quote, currency):
        raise ValueError("The paid amount is absent from its OCR quote")
    timestamp = datetime.fromisoformat(str(data.get("transaction_time", "")).replace("Z", "+00:00"))
    if timestamp.tzinfo is None:
        # A yuan receipt was printed in China (UTC+8); yen and dollar receipts keep the app's Japan time.
        timestamp = timestamp.replace(tzinfo=timezone(timedelta(hours=8 if currency == "CNY" else 9)))
    time_quote, _ = _receipt_layout(data["time_evidence"])
    date_pattern = rf"{timestamp.year}\D+0?{timestamp.month}\D+0?{timestamp.day}(?!\d)"
    clock_pattern = rf"(?<!\d)0?{timestamp.hour}[:時时]0?{timestamp.minute}(?!\d)"
    if not re.search(date_pattern, time_quote) or not re.search(clock_pattern, time_quote):
        raise ValueError("The purchase date and minute must appear in the OCR quote")
    merchant = text(data.get("merchant"))
    if not merchant or data.get("transaction_kind") != "expense" or data.get("is_transaction") is not True:
        raise ValueError("Only an identified expense can use the receipt billing path")
    if data.get("needs_review") is not False or not 0.8 <= float(data.get("confidence", 0)) <= 1:
        raise ValueError("Receipt extraction requires review")
    return {**data, "merchant": merchant, "amount": float(amount), "currency": currency,
            "CurrencyTypeNumber": CURRENCIES[currency], "transaction_time": timestamp.isoformat()}


def ledger_candidates(receipt, snapshot):
    """Scan the complete snapshot; compare purchase times at minute precision."""
    found = []
    stamp = _time(receipt["transaction_time"])
    amount = Decimal(str(receipt["amount"]))
    for bill in snapshot["dealing_data"]:
        if str(bill.get("CurrencyTypeNumber")) != str(receipt["CurrencyTypeNumber"]):
            continue
        # Earlier comma-separated OCR replies sometimes stored field labels as values.
        saved_time = re.sub(r"^(?:iso_time|isotime)\s*:\s*", "", str(bill.get("ISOtime") or ""), flags=re.I)
        date = _time(saved_time)
        delta = abs((date - stamp).total_seconds()) if date is not None else None
        if delta is not None and delta > MATCH_SECONDS:
            continue
        saved_price = re.sub(r"^prices?\s*:\s*", "", str(bill.get("price")), flags=re.I)
        price = Decimal(saved_price)
        if not price.is_finite():
            raise ValueError("Ledger contains an invalid amount")
        if abs(price - amount) > Decimal("0.01"):
            continue
        if date is None:
            raise ValueError("An equal-amount bill has no usable date")
        found.append({**bill, "time_delta_seconds": delta})
    return sorted(found, key=lambda bill: (bill["time_delta_seconds"], bill["DealingNumber"]))


def _read_evidence(source_id):
    if not source_id:
        return None
    from data_retrieval import _open_table
    from vector_store import where_eq

    table = _open_table()
    fields = [field for field in table.schema.names if field != "vector"]
    rows = table.search().where(where_eq("source_id", source_id)).select(fields).limit(1).to_list()
    return rows[0] if rows else None


def _enrich(receipt, bill, source_id, anchors):
    from adr_enrichment import run_adr_enrichment

    evidence = _read_evidence(source_id)
    if not evidence or evidence.get("source_type") != "ocr":
        raise ValueError("Stored OCR evidence is required for ADR")
    if not all(quoted(receipt[key], evidence.get("body")) for key in ("amount_evidence", "time_evidence")):
        raise ValueError("Stored OCR evidence differs from the validated receipt")
    # The OCR decision already validated this pair; reuse ADR extraction and its write checks.
    matched = {"candidates": [{"row": evidence, "score": 100,
                               "conditions": ["ocr_verified_ledger_match"]}],
               "anchors": anchors, "companions": [], "scanned_count": 1, "qualified_count": 1}
    return run_adr_enrichment(bill["DealingNumber"], incoming_id=evidence["id"],
                              matched=matched, dry_run=False)


def judge_ocr_intent(msgid=None, ocr_text="", image_path=None, *, enrich_existing=False, category_options=None):
    ocr_text = text(ocr_text)
    pairs = set()
    for row in category_options or []:
        if not isinstance(row, dict):
            continue
        main, sub = row.get("main_category"), row.get("sub_category")
        if (isinstance(main, str) and isinstance(sub, str)
                and main.strip() not in {"", "未分类", "待分类"}
                and sub.strip() not in {"", "未分类", "待分类"}):
            pairs.add((main.strip(), sub.strip()))
    options = [{"main_category": main, "sub_category": sub} for main, sub in sorted(pairs)]
    accounts, accounts_available = account_options()
    extracted = _model("extract", {"msgid": msgid, "ocr_text": ocr_text,
                                  "accounts": accounts, "accounts_available": accounts_available,
                                  "category_options": options}, msgid)
    if extracted.get("image_intent") == "non_transaction" and extracted.get("is_transaction") is False:
        if extracted.get("needs_review") is False and 0.8 <= float(extracted.get("confidence", 0)) <= 1:
            return {**extracted, "image_intent": "non_transaction"}
        return uncertain("Non-transaction judgment requires review")
    try:
        receipt = validate_receipt(extracted, ocr_text)
    except (ValueError, TypeError, ArithmeticError) as error:
        return uncertain(str(error))
    receipt.update(select_account(receipt, accounts, ocr_text, accounts_available))

    # A failed query is never interpreted as an empty database.
    candidates = ledger_candidates(receipt, _read_backend())
    common = {**receipt, "matched_dealing": {"found": False, "DealingNumber": None},
              "ledger_checked": True, "candidate_count": len(candidates), "needs_existing_deal_match": False}
    if not candidates:
        main, sub = receipt.get("main_category"), receipt.get("sub_category")
        if (not isinstance(main, str) or not isinstance(sub, str)
                or (main, sub) not in pairs):
            return uncertain("New OCR bill requires an existing main/sub category pair", **common)
        image_intent = ("new_payment_screenshot" if receipt.get("document_type") == "payment_screenshot"
                        else "new_receipt_cash")
        return {**common, "image_intent": image_intent, "needs_review": False,
                "reason": "Verified receipt; complete ledger lookup found no nearby equal-amount bill"}
    if len(candidates) > MAX_CANDIDATES:
        return uncertain("Too many equal-amount candidates; no automatic new bill", **common)

    evidence_by_bill, model_bills = {}, []
    for bill in candidates:
        row = _read_evidence(bill.get("msgid"))
        evidence_by_bill[bill["DealingNumber"]] = row
        body = text((row or {}).get("body"))
        model_bills.append({**bill, "mail_body": body[:8000], "mail_truncated": len(body) > 8000})
    decision = _model("compare", {"receipt": receipt, "ocr_text": ocr_text, "candidates": model_bills}, msgid)
    target = decision.get("DealingNumber")
    selected = next((bill for bill in candidates if type(target) is int and bill["DealingNumber"] == target), None)
    if (decision.get("decision") != "match" or selected is None or decision.get("needs_review") is not False
            or not 0.8 <= float(decision.get("confidence", 0)) <= 1
            or decision.get("merchant_relation") not in {"same", "alias"}):
        return uncertain("Candidate bills exist but their relationship is unconfirmed", **common)
    if selected["time_delta_seconds"] > MATCH_SECONDS:
        return uncertain("Purchase times differ by more than two minutes", **common)
    nearby = [bill for bill in candidates if bill["time_delta_seconds"] <= MATCH_SECONDS]
    if len(nearby) > 1:
        return uncertain("Multiple bills have the same amount and nearby time", **common)
    evidence = evidence_by_bill[target]
    source = str(selected.get("ShopName") or "") + "\n" + text((evidence or {}).get("body"))[:8000]
    if not quoted(decision.get("merchant_evidence"), source):
        return uncertain("Merchant comparison has no quote from the existing bill or mail", **common)
    result = {**common, "image_intent": "supplement_existing_deal", "needs_review": False,
              "confidence": decision["confidence"], "reason": decision.get("reason", ""),
              "account_number": selected.get("AccountNumber"), "account_match": "existing_bill",
              "account_evidence": "", "account_reason": "Preserve the existing bill account",
              "main_category": selected.get("MainCategory"), "sub_category": selected.get("SubCategory"),
              "matched_dealing": {**selected, "found": True}}
    if enrich_existing:
        result["adr_result"] = _enrich(receipt, selected, msgid, [evidence] if evidence else [])
    return result

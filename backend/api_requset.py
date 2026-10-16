from service_auth import agent_requests as requests
import os
import re


def call_bank_agent(base_url: str, operation: str, payload: dict):
    paths = {"generate": "/agent/bank-regex/generate", "process": "/agent/bank-mail/process",
             "notice": "/agent/bank-mail/notice"}
    response = requests.post(base_url.rstrip("/") + paths[operation], json=payload, timeout=180)
    response.raise_for_status()
    data = response.json()
    if not data.get("success") or not isinstance(data.get("result"), dict):
        raise ValueError("Bank Agent did not return a successful structured result")
    return data["result"]

def call_agent_user_api(base_url: str, prompt: str):
    url = f"{base_url}/agent/user"
    params = {
        "prompt": prompt
    }

    try:
        response = requests.post(url, params=params, timeout=300)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }

def call_agent_ocr_api(base_url: str, promptInput: str, file_path: str, source_id: str | None = None):
    url = f"{base_url}/agent/OCR_request"

    data = {
        "promptInput": promptInput
    }
    # The Agent logs one row per vision call under this ID, so distinct images can be counted.
    if source_id:
        data["source_id"] = source_id

    try:
        # 当前工作目录
        cwd = os.getcwd()

        # 当前这个 py 文件所在目录
        script_dir = os.path.dirname(os.path.abspath(__file__))

        # 候选路径列表
        candidate_paths = []

        # 1. 原始传入值
        if file_path:
            candidate_paths.append(file_path)

        # 2. 当前工作目录 + file_path
        if file_path and not os.path.isabs(file_path):
            candidate_paths.append(os.path.join(cwd, file_path))

        # 3. 脚本目录 + file_path
        if file_path and not os.path.isabs(file_path):
            candidate_paths.append(os.path.join(script_dir, file_path))

        # 4. 如果传进来只有文件名，再自动去 attachments 下面找
        filename_only = os.path.basename(file_path) if file_path else ""
        if filename_only:
            if os.getenv("ABK_ATTACHMENT_DIR"):
                candidate_paths.append(os.path.join(os.environ["ABK_ATTACHMENT_DIR"], filename_only))
            candidate_paths.append(os.path.join(script_dir, "attachments", filename_only))
            candidate_paths.append(os.path.join(cwd, "attachments", filename_only))

        # 去重 + 转绝对路径
        checked_paths = []
        final_path = None
        for p in candidate_paths:
            abs_path = os.path.abspath(p)
            if abs_path not in checked_paths:
                checked_paths.append(abs_path)
                if os.path.exists(abs_path) and os.path.isfile(abs_path):
                    final_path = abs_path
                    break

        # 如果还是没找到，返回更明确的报错
        if final_path is None:
            return {
                "success": False,
                "result": None,
                "status_code": 404,
                "error": (
                    "找不到文件。已尝试这些路径: "
                    + " | ".join(checked_paths)
                )
            }

        with open(final_path, "rb") as f:
            files = {
                "file": (os.path.basename(final_path), f, "application/octet-stream")
            }

            response = requests.post(url, data=data, files=files, timeout=300)
            response.raise_for_status()
            return response.json()

    except requests.RequestException as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": f"请求失败: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": f"其他错误: {str(e)}"
        }

def call_agent_ocr_intent_api(base_url: str, msgid: str, ocr_text: str, image_path: str | None = None,
                              *, enrich_existing: bool = False, category_options=None):
    url = f"{base_url}/agent/ocr-intent"

    payload = {
        "msgid": msgid,
        "ocr_text": ocr_text,
        "image_path": image_path,
        "enrich_existing": enrich_existing,
        "category_options": category_options or [],
    }

    try:
        response = requests.post(url, json=payload, timeout=600 if enrich_existing else 300)
        response.raise_for_status()
        return response.json()

    except requests.RequestException as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }

def _empty_adr_vector_ocr_intent(
    image_intent: str = "uncertain",
    reason: str = "",
    matches=None,
    needs_review: bool = True,
    confidence: float = 0.0,
):
    return {
        "image_intent": image_intent,
        "is_transaction": image_intent not in ("non_transaction", "uncertain"),
        "merchant": "",
        "amount": None,
        "currency": "unknown",
        "payment_method": "unknown",
        "account_hint": "",
        "transaction_time": "",
        "items": [],
        "matched_dealing": {
            "found": False,
            "DealingNumber": None,
            "ShopName": "",
            "price": None,
            "ISOtime": "",
            "match_score": 0.0,
            "match_reason": "",
        },
        "needs_existing_deal_match": image_intent == "supplement_existing_deal",
        "needs_review": needs_review,
        "confidence": confidence,
        "reason": reason,
        "adr_vector_matches": matches or [],
    }


def _best_adr_vector_match(matches, max_distance: float):
    clean_matches = []
    for match in matches or []:
        try:
            distance = match.get("distance")
            if distance is not None:
                match = dict(match)
                match["distance"] = float(distance)
                clean_matches.append(match)
        except (TypeError, ValueError):
            continue

    if not clean_matches:
        return None

    clean_matches.sort(key=lambda item: item["distance"])
    best = clean_matches[0]
    return best if best["distance"] <= max_distance else None


def _extract_dealing_number_from_adr_match(match):
    for key in ("source_id", "id"):
        value = str((match or {}).get(key) or "")
        found = re.search(r"dealing[:_-]?(\d+)", value, re.IGNORECASE)
        if found:
            return int(found.group(1))
    return None


def _ocr_text_looks_like_transaction(ocr_text: str):
    text = str(ocr_text or "")
    lowered = text.lower()

    amount_pattern = "(?:\u00a5|\uffe5)?\\s*\\d[\\d,]*\\s*(?:\u5186|jpy|\u5143|cny|rmb)"
    if re.search(amount_pattern, text, re.IGNORECASE):
        return True

    keywords = [
        "\u5408\u8a08", "\u5c0f\u8a08", "\u9818\u53ce", "\u6ce8\u6587", "\u652f\u6255", "\u6c7a\u6e08",
        "\u5229\u7528\u91d1\u984d", "\u5229\u7528\u5148", "\u7a0e\u8fbc", "\u7a0e\u629c", "\u5546\u54c1",
        "\u30ec\u30b7\u30fc\u30c8", "receipt", "total", "payment", "paypay", "alipay",
        "wechat", "\u652f\u4ed8\u5b9d", "\u5fae\u4fe1",
    ]
    return any(keyword.lower() in lowered for keyword in keywords)


def _ocr_text_looks_like_payment_screenshot(ocr_text: str):
    text = str(ocr_text or "").lower()
    keywords = [
        "paypay", "alipay", "wechat", "\u652f\u4ed8\u5b9d", "\u5fae\u4fe1",
        "\u652f\u6255\u3044\u5b8c\u4e86", "\u6c7a\u6e08\u5b8c\u4e86",
        "\u652f\u4ed8\u6210\u529f", "\u4ed8\u6b3e\u6210\u529f", "\u9001\u91d1",
        "payment completed",
    ]
    return any(keyword.lower() in text for keyword in keywords)


def _guess_ocr_currency(ocr_text: str):
    text = str(ocr_text or "").upper()
    original = str(ocr_text or "")
    if "JPY" in text or "\u5186" in original or "\u00a5" in original or "\uffe5" in original:
        return "JPY"
    if "CNY" in text or "RMB" in text or "\u5143" in original or "\u652f\u4ed8\u5b9d" in original or "\u5fae\u4fe1" in original:
        return "CNY"
    if "USD" in text or "$" in original or "\uff04" in original or "\u30c9\u30eb" in original or "\u7f8e\u5143" in original:
        return "USD"
    return "unknown"


def _guess_ocr_amount(ocr_text: str):
    text = str(ocr_text or "")
    patterns = [
        "(?:\u5408\u8a08|\u5c0f\u8a08|\u7dcf\u8a08|total|amount)\\D{0,12}(?:\u00a5|\uffe5)?\\s*(\\d[\\d,]*)",
        "(?:\u00a5|\uffe5)\\s*(\\d[\\d,]*)",
        "(\\d[\\d,]*)\\s*(?:\u5186|JPY)",
    ]
    for pattern in patterns:
        found = re.search(pattern, text, re.IGNORECASE)
        if found:
            try:
                return float(found.group(1).replace(",", ""))
            except ValueError:
                return None
    return None


def call_agent_adr_vector_ocr_intent_api(
    base_url: str,
    msgid: str,
    ocr_text: str,
    image_path: str | None = None,
    limit: int = 3,
    max_distance: float = 0.35,
):
    """Legacy alias: always use ledger-backed judgment, never vector-miss billing."""
    return call_agent_ocr_intent_api(base_url, msgid, ocr_text, image_path)

def read_agent_adr_memory(base_url: str, source_id: str):
    response = requests.get(base_url.rstrip("/") + "/vectorDB/adr-memory/source",
                            params={"source_id": source_id}, timeout=30)
    response.raise_for_status()
    data = response.json()
    if not data.get("success"):
        raise RuntimeError(data.get("error") or "Could not read OCR evidence")
    return data.get("result")


def call_agent_adr_memory_api(
    base_url: str,
    source_id: str,
    source_type: str = "gmail",
    amount=None,
    shop_name: str = "",
    time: str = "",
    body: str = "",
    mail_address: str = "",
    mail_subject: str = "",
    mail_snippet: str = "",
):
    url = f"{base_url}/vectorDB/adr-memory"

    payload = {
        "source_type": source_type,
        "source_id": source_id,
        "amount": amount,
        "shop_name": shop_name,
        "time": time,
        "body": body,
        "mail_address": mail_address,
        "mail_subject": mail_subject,
        "mail_snippet": mail_snippet,
    }

    try:
        response = requests.post(url, json=payload, timeout=300)
        response.raise_for_status()
        return response.json()

    except requests.RequestException as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }


def call_agent_adr_memory_batch_api(
    base_url: str,
    items: list[dict],
    batch_max_tokens: int | None = None,
    batch_max_inputs: int | None = None,
):
    url = f"{base_url}/vectorDB/adr-memory/batch"

    payload = {
        "items": items,
    }
    if batch_max_tokens is not None:
        payload["batch_max_tokens"] = batch_max_tokens
    if batch_max_inputs is not None:
        payload["batch_max_inputs"] = batch_max_inputs

    try:
        response = requests.post(url, json=payload, timeout=600)
        response.raise_for_status()
        return response.json()

    except requests.RequestException as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }


def call_agent_VDB_search(
    base_url: str,
    raw_shop_name: str,
    limit: int = 5,
    max_distance: float = 0.25,
):
    url = f"{base_url}/vectorDB/search"

    payload = {
        "raw_shop_name": raw_shop_name,
        "limit": limit,
        "max_distance": max_distance,
    }

    try:
        response = requests.post(url, json=payload, timeout=300)
        response.raise_for_status()
        data = response.json()
        result = data.get("result")

        if not result:
            return None, None, None

        shop_name = result.get("shop_name")
        main_category = result.get("main_category")
        sub_category = result.get("sub_category")

        if not shop_name or not main_category or not sub_category:
            return None, None, None

        return shop_name, main_category, sub_category

    except Exception:
        return None, None, None

def call_agent_dealing_data_classification_api(
    base_url: str,
    mail_text: str,
    raw_shop_name: str = "",
    price=None,
    iso_time: str = "",
    CurrencyTypeNumber=None,
    AccountNumber=None,
    category_options=None,
    msgid: str | None = None,
):
    url = f"{base_url}/agent/dealing-data/classify-write"

    payload = {
        "msgid": msgid,
        "mail_text": mail_text,
        "raw_shop_name": raw_shop_name,
        "price": price,
        "iso_time": iso_time,
        "CurrencyTypeNumber": CurrencyTypeNumber,
        "AccountNumber": AccountNumber,
        "category_options": category_options or [],
    }

    try:
        response = requests.post(url, json=payload, timeout=300)
        response.raise_for_status()
        return response.json()

    except requests.RequestException as e:
        return {
            "success": False,
            "result": None,
            "raw_result": None,
            "status_code": 500,
            "error": str(e)
        }

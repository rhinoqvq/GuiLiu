from runtime_settings import configure_utf8

configure_utf8()

import html
import re
import time
import os
from email.utils import parseaddr
from googleapiclient.errors import HttpError

from mail_access import MailClient as gmailM
from api_requset import (
    call_agent_adr_memory_api,
    call_agent_adr_memory_batch_api,
    call_agent_ocr_api,
    read_agent_adr_memory,
)


ADR_MEMORY_PAYLOAD_KEYS = [
    "source_type",
    "source_id",
    "amount",
    "shop_name",
    "time",
    "body",
    "mail_address",
    "mail_subject",
    "mail_snippet",
]
DEFAULT_ADR_EMBEDDING_BATCH_MAX_TOKENS = 250000
DEFAULT_ADR_EMBEDDING_BATCH_MAX_INPUTS = 2048
DEFAULT_ADR_EMBEDDING_CHARS_PER_TOKEN = 2.5


def clean_html(html_text: str) -> str:
    text = str(html_text or "")
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def extract_mail_address(from_value: str) -> str:
    name, address = parseaddr(str(from_value or ""))
    return clean_text(address or from_value)


def build_adr_memory_body(mail_data: dict, max_chars: int = 12000) -> str:
    body_text = str(mail_data.get("body_text") or "").strip()
    if not body_text:
        body_text = clean_html(mail_data.get("body_html") or "")

    headers = [
        ("From", mail_data.get("from")),
        ("To", mail_data.get("to")),
        ("Date", mail_data.get("date")),
        ("Subject", mail_data.get("subject")),
        ("Snippet", mail_data.get("snippet")),
    ]
    header_text = "\n".join(
        f"{name}: {value}"
        for name, value in headers
        if value
    )

    body = "\n\n".join(part for part in [header_text, body_text] if part).strip()
    if max_chars and len(body) > max_chars:
        body = body[:max_chars]
    return body


def build_adr_memory_payload(mail_data: dict, max_chars: int = 12000) -> dict:
    return {
        "source_type": mail_data.get("source_type") or "gmail",
        "source_id": str(mail_data.get("msg_id") or ""),
        "amount": None,
        "shop_name": "",
        "time": str(mail_data.get("date") or ""),
        "body": build_adr_memory_body(mail_data, max_chars=max_chars),
        "mail_address": extract_mail_address(mail_data.get("from")),
        "mail_subject": clean_text(mail_data.get("subject")),
        "mail_snippet": clean_text(mail_data.get("snippet")),
    }


def estimate_adr_memory_payload_tokens(payload: dict) -> int:
    embedding_text = clean_text(
        " ".join(
            str(payload.get(key) or "")
            for key in ["mail_address", "mail_subject", "time", "body"]
        )
    )
    if not embedding_text:
        return 0
    return max(
        1,
        int(len(embedding_text) / DEFAULT_ADR_EMBEDDING_CHARS_PER_TOKEN) + 1,
    )


def adr_memory_payload_for_agent(payload: dict) -> dict:
    return {key: payload.get(key) for key in ADR_MEMORY_PAYLOAD_KEYS}


def flush_adr_memory_payload_batch(
    pending_payloads: list[dict],
    agent_base_url: str,
    db,
    stats: dict,
    batch_max_tokens: int,
    batch_max_inputs: int,
):
    if not pending_payloads:
        return

    result = call_agent_adr_memory_batch_api(
        base_url=agent_base_url,
        items=[
            adr_memory_payload_for_agent(payload)
            for payload in pending_payloads
        ],
        batch_max_tokens=batch_max_tokens,
        batch_max_inputs=batch_max_inputs,
    )
    result_body = result.get("result") or {}
    item_results = result_body.get("items") or []
    item_by_source_id = {
        str(item.get("source_id") or ""): item
        for item in item_results
    }

    if not item_by_source_id and not result.get("success"):
        stats["failed"] += len(pending_payloads)
        print("ADR vector batch failed: " + str(result.get("error")))
        return

    for payload in pending_payloads:
        source_id = str(payload.get("source_id") or "")
        msgid = str(payload.get("_msgid") or source_id)
        item_result = item_by_source_id.get(source_id)

        if item_result and item_result.get("success"):
            skipped = bool(item_result.get("skipped"))
            stats["skipped_existing" if skipped else "created"] += 1
            db.C_for_ADRDoneList(
                msgid,
                payload.get("source_type") or "gmail",
                "skipped" if skipped else "success",
            )
            print(
                ("ADR vector exists msgid: " if skipped else "ADR vector created msgid: ")
                + msgid
            )
        else:
            stats["failed"] += 1
            error = (
                item_result.get("error")
                if item_result
                else result.get("error")
            )
            print("ADR vector failed msgid: " + msgid + " error: " + str(error))


def write_mail_to_adr_vector_memory(
    mail_data: dict,
    agent_base_url: str,
    db,
    max_chars: int = 12000,
):
    msgid = str(mail_data.get("msg_id") or "")
    if not msgid:
        return {
            "success": False,
            "skipped": False,
            "msgid": msgid,
            "error": "missing msg_id",
            "result": None,
        }

    payload = build_adr_memory_payload(mail_data, max_chars=max_chars)
    if not payload["body"] and not payload["mail_subject"] and not payload["mail_snippet"]:
        return {
            "success": False,
            "skipped": True,
            "msgid": msgid,
            "error": "empty mail text",
            "result": None,
        }

    result = call_agent_adr_memory_api(
        base_url=agent_base_url,
        source_id=payload["source_id"],
        source_type=payload["source_type"],
        amount=payload["amount"],
        shop_name=payload["shop_name"],
        time=payload["time"],
        body=payload["body"],
        mail_address=payload["mail_address"],
        mail_subject=payload["mail_subject"],
        mail_snippet=payload["mail_snippet"],
    )

    if result.get("success"):
        db.C_for_ADRDoneList(msgid, payload["source_type"], "success")

    return {
        "success": bool(result.get("success")),
        "skipped": bool((result.get("result") or {}).get("skipped")),
        "msgid": msgid,
        "error": result.get("error"),
        "result": result.get("result"),
    }


def build_ocr_adr_memory_payload(
    mail_data: dict,
    ocr_text: str,
    image_path: str = "",
    image_index: int | None = None,
    max_chars: int = 12000,
) -> dict:
    msgid = str(mail_data.get("msg_id") or "").strip()
    source_id = f"ocr:{msgid}"
    if image_index is not None:
        source_id = f"{source_id}:{image_index}"

    headers = [
        ("From", mail_data.get("from")),
        ("To", mail_data.get("to")),
        ("Date", mail_data.get("date")),
        ("Subject", mail_data.get("subject")),
        ("Snippet", mail_data.get("snippet")),
        ("OCRImage", image_path),
    ]
    header_text = "\n".join(
        f"{name}: {value}"
        for name, value in headers
        if value
    )
    body = "\n\n".join(
        part
        for part in [
            header_text,
            "OCR Text:\n" + str(ocr_text or "").strip(),
        ]
        if part
    ).strip()
    if max_chars and len(body) > max_chars:
        body = body[:max_chars]

    return {
        "source_type": "ocr",
        "source_id": source_id,
        "amount": None,
        "shop_name": "",
        "time": str(mail_data.get("date") or ""),
        "body": body,
        "mail_address": extract_mail_address(mail_data.get("from")),
        "mail_subject": clean_text(mail_data.get("subject")),
        "mail_snippet": clean_text(mail_data.get("snippet")),
    }


def write_ocr_to_adr_vector_memory(
    mail_data: dict,
    ocr_text: str,
    agent_base_url: str,
    image_path: str = "",
    image_index: int | None = None,
    db=None,
    max_chars: int = 12000,
) -> dict:
    payload = build_ocr_adr_memory_payload(
        mail_data=mail_data,
        ocr_text=ocr_text,
        image_path=image_path,
        image_index=image_index,
        max_chars=0,
    )
    source_id = payload["source_id"]
    if not source_id or source_id == "ocr:":
        return {
            "success": False,
            "skipped": False,
            "source_id": source_id,
            "error": "missing msg_id",
            "result": None,
        }
    if not str(ocr_text or "").strip():
        return {
            "success": False,
            "skipped": True,
            "source_id": source_id,
            "error": "empty ocr text",
            "result": None,
        }

    result = call_agent_adr_memory_api(
        base_url=agent_base_url,
        source_id=payload["source_id"],
        source_type=payload["source_type"],
        amount=payload["amount"],
        shop_name=payload["shop_name"],
        time=payload["time"],
        body=payload["body"],
        mail_address=payload["mail_address"],
        mail_subject=payload["mail_subject"],
        mail_snippet=payload["mail_snippet"],
    )

    skipped = bool((result.get("result") or {}).get("skipped"))
    if result.get("success") and db is not None:
        if db.C_for_OCRDoneList(source_id, image_path) != 100:
            return {
                "success": False, "skipped": skipped, "source_id": source_id,
                "error": "Could not mark OCR evidence import complete", "result": result.get("result"),
            }

    return {
        "success": bool(result.get("success")),
        "skipped": skipped,
        "source_id": source_id,
        "error": result.get("error"),
        "result": result.get("result"),
    }


def prepare_ocr_evidence(gmail, msgid, image, agent_base_url, db, *, ocr_prompt_input=200):
    """One shared preparation path; only vector-confirmed OCR gets a done marker."""
    source_id = f"ocr:{msgid}:{image['index']}"
    with gmailM.image_lock("ocr:" + source_id):
        # Also covers a successful vector write followed by a failed local done write.
        existing = read_agent_adr_memory(agent_base_url, source_id)
        if existing is not None:
            if existing.get("source_type") != "ocr":
                raise ValueError("OCR source ID belongs to non-OCR evidence")
            body = str(existing.get("body") or "")
            _, marker, text = body.partition("OCR Text:\n")
            text = text.strip() if marker else body.strip()
            if not text:
                raise ValueError("Stored OCR evidence is empty; do not mark complete")
            path_match = re.search(r"(?m)^OCRImage: (.+)$", body)
            path = path_match.group(1).strip() if path_match else image["path"]
            allowed = {os.path.normcase(os.path.abspath(p)) for p in
                       (image["path"], image.get("legacy_path")) if p}
            if os.path.normcase(os.path.abspath(path)) not in allowed:
                raise ValueError("Stored OCR image path disagrees with its image index; manual review required")
            if db.C_for_OCRDoneList(source_id, path) != 100:
                raise RuntimeError("Could not record completed OCR")
            return {"source_id": source_id, "image_path": path, "ocr_text": text, "reused": True}

        # The existing downloader verifies and reuses complete local files.
        image_path = gmail.download_gmail_image(msgid, image)
        result = call_agent_ocr_api(agent_base_url, ocr_prompt_input, image_path, source_id)
        if not result.get("success") or not str(result.get("result") or "").strip():
            raise RuntimeError("OCR failed: " + str(result.get("error") or "empty text"))
        text = result["result"]
        written = write_ocr_to_adr_vector_memory(
            gmail.get_mail_data(msgid), text, agent_base_url,
            image_path=image_path, image_index=image["index"], db=db,
        )
        if not written.get("success"):
            raise RuntimeError("OCR vector write failed: " + str(written.get("error")))
        return {"source_id": source_id, "image_path": image_path, "ocr_text": text, "reused": False}


def gmail_sender_query(mail_address_or_query: str) -> str:
    value = str(mail_address_or_query or "").strip()
    if not value:
        return "in:inbox"
    if ":" in value or " " in value:
        return value
    return f"from:{value}"


def import_gmail_ocr_to_adr_memory_by_sender(
    mail_address: str,
    agent_base_url: str,
    db=None,
    limit: int = 0,
    max_chars: int = 12000,
    max_images_per_mail: int = 0,
    sleep_seconds: float = 0.05,
    dry_run: bool = False,
    skip_done: bool = True,
    ocr_prompt_input=200,
    scan_limit: int | None = None,
):
    """
    OCR image attachments from all Gmail messages matching a sender/query,
    then write OCR text into adr_memory with source_id "ocr:<msgid>:<image_index>".

    mail_address can be a plain address ("foo@example.com") or a Gmail query
    ("from:foo@example.com newer_than:30d").
    With skip_done and a database, a positive limit counts only messages
    containing unfinished images. limit=0 preserves the full import.
    """
    query = gmail_sender_query(mail_address)
    gmail = gmailM(query)
    gmail.connect_gmail()

    if db is None:
        from database import DBmanage
        from runtime_settings import database_path
        db = DBmanage(database_path())
    db.ensure_OCRDoneList()

    selected_images = {}
    if limit and limit > 0 and skip_done and db is not None:
        def needs_ocr(msgid):
            try:
                images = gmail.list_gmail_images(msgid, max_images=max_images_per_mail)
                pending = any(
                    db.R_for_OCRDoneList(f"ocr:{msgid}:{image['index']}") is None
                    for image in images
                )
            except HttpError:
                # Do not turn quota failures into ten more candidate fetches.
                raise
            except Exception as error:
                # Keep failed fetches pending and report them in the normal loop.
                selected_images[msgid] = error
                return True
            if pending:
                selected_images[msgid] = images
            return pending

        msgid_list = gmail.get_unprocessed_mail_ids(
            needs_ocr, max_results=limit, scan_limit=scan_limit,
        )
    else:
        msgid_list = gmail.get_all_msgid()
        if limit and limit > 0:
            msgid_list = msgid_list[:limit]

    stats = {
        "query": query,
        "messages": len(msgid_list),
        "images": 0,
        "created": 0,
        "skipped_done": 0,
        "skipped_existing": 0,
        "no_image": 0,
        "ocr_failed": 0,
        "write_failed": 0,
        "failed": 0,
        "dry_run": 0,
    }
    print("ADR OCR import found messages: " + str(len(msgid_list)) + " query: " + query)

    for msg_index, msgid in enumerate(msgid_list, start=1):
        try:
            images = selected_images.get(msgid)
            if isinstance(images, Exception):
                raise images
            if images is None:
                images = gmail.list_gmail_images(
                    msgid,
                    max_images=max_images_per_mail,
                )
            if not images:
                stats["no_image"] += 1
                print(f"[{msg_index}/{len(msgid_list)}] no image: {msgid}")
                continue

            for image in images:
                image_index = image["index"]
                stats["images"] += 1
                source_id = f"ocr:{msgid}:{image_index}"

                if skip_done and db.R_for_OCRDoneList(source_id) is not None:
                    stats["skipped_done"] += 1
                    print(f"[{msg_index}/{len(msgid_list)}] skipped done: {source_id}")
                    continue

                if dry_run:
                    stats["dry_run"] += 1
                    print(f"[{msg_index}/{len(msgid_list)}] dry-run OCR ADR: {source_id} {image['path']}")
                    continue

                prepared = prepare_ocr_evidence(
                    gmail, msgid, image, agent_base_url, db, ocr_prompt_input=ocr_prompt_input,
                )
                stats["skipped_existing" if prepared["reused"] else "created"] += 1

                if sleep_seconds:
                    time.sleep(sleep_seconds)

        except KeyboardInterrupt:
            raise
        except HttpError:
            raise
        except Exception as e:
            stats["failed"] += 1
            if str(e).startswith("OCR failed:"):
                stats["ocr_failed"] += 1
            elif str(e).startswith("OCR vector write failed:"):
                stats["write_failed"] += 1
            print(f"[{msg_index}/{len(msgid_list)}] ADR OCR import error msgid={msgid}: {e}")

    print("ADR OCR import stats: " + str(stats))
    return stats


def sync_recent_gmail_to_adr_memory(
    agent_base_url: str,
    db,
    mail_query: str = "in:inbox",
    max_results: int = 10,
    max_chars: int = 12000,
    sleep_seconds: float = 0.05,
    batch_max_tokens: int = DEFAULT_ADR_EMBEDDING_BATCH_MAX_TOKENS,
    batch_max_inputs: int = DEFAULT_ADR_EMBEDDING_BATCH_MAX_INPUTS,
    scan_limit: int | None = None,
):
    db.ensure_ADRDoneList()

    bank_mail = gmailM(mail_query)
    bank_mail.connect_gmail()

    msgid_list = (
        bank_mail.get_all_msgid()
        if max_results is not None and max_results <= 0
        else bank_mail.get_unprocessed_mail_ids(
            db.R_for_ADRDoneList, max_results=10 if max_results is None else max_results,
            scan_limit=scan_limit,
        )
    )
    stats = {
        "checked": len(msgid_list),
        "created": 0,
        "skipped_done": 0,
        "skipped_existing": 0,
        "skipped_empty": 0,
        "failed": 0,
    }

    pending_payloads = []
    pending_tokens = 0

    def flush_pending_payloads():
        nonlocal pending_payloads, pending_tokens
        flush_adr_memory_payload_batch(
            pending_payloads=pending_payloads,
            agent_base_url=agent_base_url,
            db=db,
            stats=stats,
            batch_max_tokens=batch_max_tokens,
            batch_max_inputs=batch_max_inputs,
        )
        pending_payloads = []
        pending_tokens = 0

    for msgid in msgid_list:
        is_new_for_vector = db.R_for_ADRDoneList(str(msgid))
        if not is_new_for_vector:
            stats["skipped_done"] += 1
            print("ADR vector already done msgid: " + str(msgid))
            continue

        try:
            mail_data = bank_mail.get_mail_data(msgid)
            payload = build_adr_memory_payload(mail_data, max_chars=max_chars)
            if not payload["body"] and not payload["mail_subject"] and not payload["mail_snippet"]:
                stats["skipped_empty"] += 1
                print("ADR vector skipped empty msgid: " + str(msgid))
                continue

            payload["_msgid"] = str(msgid)
            estimated_tokens = estimate_adr_memory_payload_tokens(payload)

            if pending_payloads and (
                len(pending_payloads) >= batch_max_inputs
                or pending_tokens + estimated_tokens > batch_max_tokens
            ):
                flush_pending_payloads()

            pending_payloads.append(payload)
            pending_tokens += estimated_tokens

            if sleep_seconds:
                time.sleep(sleep_seconds)

        except Exception as e:
            stats["failed"] += 1
            print("ADR vector flow error msgid: " + str(msgid) + " error: " + str(e))

    flush_pending_payloads()

    print("ADR vector sync stats: " + str(stats))
    return stats


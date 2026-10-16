from runtime_settings import configure_utf8

configure_utf8()

from fastapi import FastAPI, Depends, HTTPException, Security,status,File,UploadFile,Form,Query, Header, Body
from fastapi.responses import JSONResponse
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from service_auth import ServiceAuthMiddleware
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator
from dashscope import MultiModalConversation
import base64
from agent import (
    FinalAnswerFormatError,
    qwenMax,
    OCR_qianwenVL,
    run_ocr_intent_agent,
    run_mail_classification_agent,
    run_dealing_data_classification_agent,
)
from adr_enrichment import run_adr_enrichment
from import_agent import router as import_router
from plans import create_plans_router
from automation import AutomationStore, AutomationRuntime, AutomationError, TaskCreate, StrictModel, AGENT_ENTRIES
from pydantic import ValidationError
import os
import sqlite3

from typing import Any, Literal
from visualization_models import ChatTurnResult
from visualization_context import read_visualization_history
from chat_history import ChatHistoryStore, ChatSessionDeletedError, validate_session_id
from context_manager import ContextBusyError
import agent_activity
from automation import reply_to_insight
from runtime_settings import get_setting, get_language, prompt_language
from uuid import uuid4
from pydantic import BaseModel
from fastapi import status
import json
import re
from tool import (
    judge_ocr_intent,
    list_prompts,
    get_prompt,
    update_prompt,
    open_prompt,
    create_adr_memory_api,
    create_adr_memory_batch_api,
    search_adr_memory_by_text,
    list_adr_memory_by_source_type,
    get_adr_memory_by_source,
)
from classification_memory_search import search_classification_by_raw_shop_name
from embedding_client import get_embedding_client
from bank_regex_agent import BankRegexRequest, generate_bank_regex, bank_model_error
from bank_accounting_agent import (
    BankAccountingRequest, BankNoticeRequest, process_bank_accounting, publish_bank_notice,
)
from vector_store import classification_case_memory_store, merchant_memory_store, where_eq
from fastapi import Request
from initial_setup import (CredentialSettings, save_credentials, setup_status,
                           prepare_stores, runtime_allowed, DiscoveryRequest, discover_bank_sources)

class Prompt_update_request_structure(BaseModel):
    description: str | None = None
    model: str | None = None
    prompt: str | None = None
    input_variables: list[str] | None = None

class OCRIntent_request_structure(BaseModel):
    msgid: str | None = None
    ocr_text: str
    image_path: str | None = None
    enrich_existing: bool = False
    category_options: list[dict[str, str]] = Field(default_factory=list)

class OCRIntent_Response_structure(BaseModel):
    success: bool
    result: Any | None = None
    status_code: int | None = None
    error: str | None = None

class MailClassification_request_structure(BaseModel):
    msgid: str | None = None
    source_type: str | None = "gmail"
    mail_subject: str | None = ""
    mail_snippet: str | None = ""
    mail_body: str | None = ""
    mail_from: str | None = ""
    mail_time: str | None = ""
    amount: float | str | None = None
    shop_name: str | None = ""
    user_tags: Any | None = None

class MailClassification_Response_structure(BaseModel):
    success: bool
    result: Any | None = None
    raw_result: str | None = None
    status_code: int | None = None
    error: str | None = None

class DealingDataClassification_request_structure(BaseModel):
    msgid: str | None = None
    mail_text: str
    raw_shop_name: str | None = ""
    price: float | str | None = None
    iso_time: str | None = ""
    CurrencyTypeNumber: int | str | None = None
    AccountNumber: int | str | None = None
    category_options: Any | None = None

class DealingDataClassification_Response_structure(BaseModel):
    success: bool
    result: Any | None = None
    raw_result: str | None = None
    status_code: int | None = None
    error: str | None = None


class ClassificationMemorySearch_request_structure(BaseModel):
    raw_shop_name: str
    item_name: str | None = ""
    item_type: str | None = ""
    limit: int | None = 5
    max_distance: float | None = 0.35
    case_max_distance: float | None = 0.35


class ClassificationMemorySearch_Response_structure(BaseModel):
    success: bool
    result: Any | None = None
    status_code: int | None = None
    error: str | None = None


class ClassificationCaseCategorySync_request_structure(BaseModel):
    old_main_category: str
    old_sub_category: str
    old_detail_category: str | None = ""
    new_main_category: str
    new_sub_category: str
    new_detail_category: str | None = ""
    old_shop_name: str | None = ""
    new_shop_name: str | None = ""
    changed_fields: list[str] | None = None
    limit: int | None = 50000


class ADRMemoryCreate_request_structure(BaseModel):
    source_type: str | None = "gmail"
    source_id: str
    amount: float | str | None = None
    shop_name: str | None = ""
    time: str | None = ""
    body: str | None = ""
    mail_address: str | None = ""
    mail_subject: str | None = ""
    mail_snippet: str | None = ""


class ADRMemoryBatchCreate_request_structure(BaseModel):
    items: list[ADRMemoryCreate_request_structure]
    batch_max_tokens: int | None = None
    batch_max_inputs: int | None = None
    initialization: bool = False


class ADRMemorySearch_request_structure(BaseModel):
    query_text: str
    limit: int | None = 3
    exclude_source_ids: list[str] = Field(default_factory=list, max_length=100)


class ADRMemoryList_request_structure(BaseModel):
    source_type: str | None = "ocr"
    limit: int | None = 1000

class ADR_Response_structure(BaseModel):
    success: bool
    result: Any | None = None
    status_code: int | None = None
    error: str | None = None


class ADREnrichmentRequest(BaseModel):
    DealingNumber: int
    dry_run: bool = True
    match_only: bool = False
    attempt_token: str | None = None




class OCR_Response_structure(BaseModel):
    success:bool
    result:str | None = None
    status_code:str | None = None
    error:str | None = None

class OCR_request_structure(BaseModel):
    prompt:str
    row_data:str

#分类请求的相应结构体跟返回结构体
class user_Response_structure(BaseModel):
    success: bool
    result: ChatTurnResult | str | None = None
    status_code: int | None = None
    error: str | None = None
    session_id: str | None = None

class categor_request_structure(BaseModel):
    prompt:str
    row_data:str

class AutoRetrieval_Response_structure(BaseModel):
    success: bool
    result: str | None = None
    status_code: str | None = None
    
from contextlib import asynccontextmanager
from adr_events import evidence_worker
import asyncio
import signal
from fastapi import BackgroundTasks
from pydantic import StrictBool


def start_agent_runtime(app):
    if app.state.automation_requested and not app.state.automation_enabled:
        app.state.automation_runtime.start()
        app.state.automation_enabled = True
    evidence_worker.start()


@asynccontextmanager
async def lifespan(app):
    app.state.stopping = False
    history = ChatHistoryStore()
    history.recover_interrupted()
    history.import_existing()
    app.state.chat_history = history
    store = AutomationStore()
    store.initialize()
    store.recover_replies()
    runtime = AutomationRuntime(store)
    app.state.automation_store = store
    app.state.automation_runtime = runtime
    app.state.automation_requested = get_setting("automation.enabled", True, "ABK_AUTOMATION_ENABLED")
    app.state.automation_enabled = False
    if runtime_allowed():
        start_agent_runtime(app)
    try:
        yield
    finally:
        runtime.stop()
        evidence_worker.stop()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def select_prompt_language(request: Request, call_next):
    if request.method not in {"POST", "PUT", "PATCH"} and not request.url.path.startswith("/prompts"):
        return await call_next(request)
    try:
        language = get_language(request.query_params.get("language"))
    except ValueError as error:
        return JSONResponse(status_code=422, content={"detail": str(error)})
    with prompt_language(language):
        return await call_next(request)


app.add_middleware(ServiceAuthMiddleware, service="agent")


def require_local_setup(request: Request):
    if request.client is None or request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(403, "Initialization is local-only")
    origin = request.headers.get("origin")
    if origin:
        from urllib.parse import urlsplit
        if urlsplit(origin).hostname not in {"127.0.0.1", "localhost", "::1"}:
            raise HTTPException(403, "Untrusted initialization origin")


@app.get("/agent/initialization", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_status():
    return {"success": True, "result": setup_status(), "error": None}


@app.put("/agent/initialization/settings", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_settings(settings: CredentialSettings):
    return {"success": True, "result": save_credentials(settings), "error": None}


class ApiCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dashscope_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None


@app.post("/agent/initialization/verify", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_verify(request: ApiCheckRequest):
    # Keys under test arrive before they are saved; a key left out is read from the saved credentials.
    from api_check import verify_api_keys
    secret = lambda value: value.get_secret_value() if value is not None else None
    return {"success": True, "result": verify_api_keys(secret(request.dashscope_api_key), secret(request.openai_api_key)),
            "error": None}


@app.post("/agent/initialization/prepare", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_prepare():
    return {"success": True, "result": prepare_stores(), "error": None}


@app.post("/agent/initialization/complete", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_complete(request: Request):
    if not runtime_allowed():
        raise HTTPException(409, "Backend initialization has not completed")
    start_agent_runtime(request.app)
    return {"success": True, "result": {"initialized": True}, "error": None}


class SetupNotice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=4000)
    key: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")


@app.post("/agent/initialization/notice", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_notice(notice: SetupNotice):
    """A message in the information feed for the user, e.g. that a mailbox added in Settings awaits confirmation.
    The same key is saved once, so a retried request does not repeat the message."""
    from datetime import datetime, timedelta, timezone
    from automation import InsightInput
    store = app.state.automation_store
    now = datetime.now(timezone.utc)
    data = InsightInput(title=notice.title, content=notice.content, kind="analysis", topic_key="setup:" + notice.key,
                        period_start=(now - timedelta(minutes=1)).isoformat(), period_end=now.isoformat(),
                        evidence_ids=["setup:" + notice.key])
    return {"success": True, "result": store.save_insight(data, {"source_calls": [{"tool": "setup_notice"}]}), "error": None}


@app.post("/agent/initialization/discover", dependencies=[Depends(require_local_setup)], tags=["initialization"])
def agent_initialization_discover(request: DiscoveryRequest):
    try:
        return {"success": True, "result": discover_bank_sources(request), "error": None}
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "result": None,
                            "error": type(error).__name__ + ": bank discovery failed", **bank_model_error(error)})


@app.post("/agent/bank-regex/generate", tags=["bank-mail"])
def bank_regex_generate(req: BankRegexRequest):
    try:
        return {"success": True, "result": generate_bank_regex(req), "error": None}
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "result": None,
                            "error": type(error).__name__ + ": bank regex generation failed", **bank_model_error(error)})


@app.post("/agent/bank-mail/process", tags=["bank-mail"])
def bank_mail_process(req: BankAccountingRequest):
    try:
        return {"success": True, "result": process_bank_accounting(req), "error": None}
    except Exception as error:
        return JSONResponse(status_code=502, content={"success": False, "result": None,
                            "error": type(error).__name__ + ": bank mail processing failed"})


@app.post("/agent/bank-mail/notice", tags=["bank-mail"])
def bank_mail_notice(req: BankNoticeRequest):
    try:
        return {"success": True, "result": publish_bank_notice(req), "error": None}
    except Exception as error:
        return JSONResponse(status_code=503, content={"success": False, "result": None,
                            "error": type(error).__name__ + ": bank notice could not be saved"})
app.include_router(import_router)
app.include_router(create_plans_router())


@app.get("/agent/health", status_code=status.HTTP_200_OK)
async def agent_health():
    """Report API liveness without calling models, tools, or databases."""
    return {"success": True, "result": {"status": "online"}, "status_code": 200, "error": None}


class ServiceShutdownRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: StrictBool


async def exit_agent_service():
    await asyncio.sleep(0.3)
    signal.raise_signal(signal.SIGINT)


@app.post("/agent/system/shutdown", dependencies=[Depends(require_local_setup)], status_code=202, tags=["System"])
async def shutdown_agent_service(payload: ServiceShutdownRequest, request: Request, background_tasks: BackgroundTasks):
    from urllib.parse import urlsplit
    if (request.headers.get("x-guiliu-control") != "shutdown"
            or urlsplit("http://" + request.headers.get("host", "")).hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}):
        raise HTTPException(403, "Local system control header and host required")
    if not payload.confirm:
        raise HTTPException(422, "Confirm shutdown explicitly")
    if not request.app.state.stopping:
        request.app.state.stopping = True
        background_tasks.add_task(exit_agent_service)
    return {"success": True, "result": {"status": "shutting_down", "service": "agent"},
            "error": None, "status_code": 202}


def automation_response(callback, status_code=200):
    try:
        return JSONResponse({"success": True, "result": callback(), "error": None,
                             "status_code": status_code}, status_code=status_code)
    except (AutomationError, ValidationError, sqlite3.Error) as error:
        code = error.status if isinstance(error, AutomationError) else (422 if isinstance(error, ValidationError) else 503)
        message = "Automation storage unavailable" if isinstance(error, sqlite3.Error) else str(error)
        return JSONResponse({"success": False, "result": None, "error": message,
                             "status_code": code}, status_code=code)


@app.get("/agent/automation-agents", tags=["Automation"])
def automation_agents():
    return automation_response(lambda: {"items": [{"agent_key": key, "name": entry["name"]}
                                                  for key, entry in AGENT_ENTRIES.items()]})


@app.get("/agent/automations", tags=["Automation"])
def list_automations():
    return automation_response(lambda: {"items": app.state.automation_store.tasks(),
                                        "worker_enabled": app.state.automation_enabled})


@app.post("/agent/automations", tags=["Automation"])
def create_automation(req: TaskCreate):
    return automation_response(lambda: app.state.automation_store.create_task(req), 201)


@app.get("/agent/automations/{task_id}", tags=["Automation"])
def get_automation(task_id: str):
    return automation_response(lambda: app.state.automation_store.task(task_id))


@app.patch("/agent/automations/{task_id}", tags=["Automation"])
def update_automation(task_id: str, changes: dict = Body(...)):
    return automation_response(lambda: app.state.automation_store.update_task(task_id, changes))


@app.delete("/agent/automations/{task_id}", tags=["Automation"])
def delete_automation(task_id: str):
    return automation_response(lambda: app.state.automation_store.delete_task(task_id))


@app.post("/agent/automations/{task_id}/run", tags=["Automation"])
def run_automation(task_id: str, idempotency_key: str = Header(min_length=1, max_length=200)):
    def enqueue():
        if not app.state.automation_enabled:
            raise AutomationError("Automation worker is disabled", 503)
        run = app.state.automation_store.enqueue_manual(task_id, idempotency_key)
        app.state.automation_runtime.wake.set()
        return run
    return automation_response(enqueue, 202)


@app.get("/agent/automations/{task_id}/runs", tags=["Automation"])
def automation_runs(task_id: str, limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    return automation_response(lambda: app.state.automation_store.runs(task_id, limit, offset))


@app.get("/agent/automation-runs/{run_id}", tags=["Automation"])
def automation_run(run_id: str):
    return automation_response(lambda: app.state.automation_store.run(run_id))


class InsightReadRequest(StrictModel):
    is_read: bool | None = None
    confirmed: bool | None = None

    @model_validator(mode="after")
    def something_to_change(self):
        if self.is_read is None and self.confirmed is None:
            raise ValueError("Give is_read or confirmed")
        return self


class InsightReplyRequest(StrictModel):
    message: str = Field(min_length=1, max_length=8000)


@app.post("/agent/insights/{insight_id}/reply", tags=["Agent information"])
def reply_agent_insight(insight_id: str, req: InsightReplyRequest,
                        idempotency_key: str = Header(min_length=1, max_length=200)):
    return automation_response(lambda: reply_to_insight(
        app.state.automation_store, insight_id, req.message, idempotency_key, app.state.chat_history.root,
    ))


@app.get("/agent/insights", tags=["Agent information"])
def list_agent_insights(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
                       unread_only: bool = False, kind: Literal["analysis", "anomaly", "pending_confirmation"] | None = None):
    return automation_response(lambda: app.state.automation_store.insights(limit, offset, unread_only, kind))


@app.get("/agent/insights/{insight_id}", tags=["Agent information"])
def get_agent_insight(insight_id: str):
    return automation_response(lambda: app.state.automation_store.insight(insight_id))


@app.patch("/agent/insights/{insight_id}", tags=["Agent information"])
def mark_agent_insight(insight_id: str, req: InsightReadRequest):
    return automation_response(lambda: app.state.automation_store.insight(insight_id, req.is_read, req.confirmed))


@app.post("/agent/adr/enrich", response_model=ADR_Response_structure)
def enrich_adr(req: ADREnrichmentRequest):
    try:
        result = run_adr_enrichment(
            req.DealingNumber, dry_run=req.dry_run, match_only=req.match_only, attempt_token=req.attempt_token,
        )
        return ADR_Response_structure(success=True, result=result, status_code=200)
    except Exception as error:
        return ADR_Response_structure(success=False, error=str(error), status_code=500)

# OCR 请求的接口
@app.post("/agent/OCR_request", response_model=OCR_Response_structure, status_code=status.HTTP_200_OK)
async def OCR_request(
    promptInput: str = Form(...),
    file: UploadFile = File(...),
    source_id: str | None = Form(None),
):
    try:
        # Optional "ocr:<msgid>:<n>" so the log can count distinct images; never free text.
        if source_id is not None and not re.fullmatch(r"[A-Za-z0-9:_.@-]{1,200}", source_id):
            return OCR_Response_structure(success=False, result=None, stating_code="400", error="Invalid source_id")
        file_bytes = await file.read()

        if not file_bytes:
            return OCR_Response_structure(
                success=False,
                result=None,
                stating_code="400",
                error="上传文件为空"
            )

        img_base64 = base64.b64encode(file_bytes).decode("utf-8")

        prompt = open_prompt("ocr_extract", promptInput=promptInput)

        # The model call takes seconds; run it off the event loop so health checks and chat stay responsive.
        result_text = await run_in_threadpool(OCR_qianwenVL, img_base64, prompt, source_id)

        return OCR_Response_structure(
            success=True,
            result=result_text,
            stating_code="200",
            error=None
        )

    except Exception as e:
        print(f"OCR_request 出错: {e}")
        return OCR_Response_structure(
            success=False,
            result=None,
            stating_code="500",
            error=str(e)
        )

# 用户请求的接口
@app.post("/agent/user",response_model=user_Response_structure,status_code=status.HTTP_200_OK)
def user_request(prompt:str, session_id: str | None = None,
                 response_format: Literal["text", "structured"] = "text", user_message: str | None = None,
                 language: Literal["zh", "ja", "en"] | None = None):
    session_id = session_id or uuid4().hex
    try:
        validate_session_id(session_id)
        store = getattr(app.state, "chat_history", None) or ChatHistoryStore()
        store.ensure_active(session_id)
    except ChatSessionDeletedError as error:
        raise HTTPException(status_code=410, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except sqlite3.Error as error:
        raise HTTPException(status_code=503, detail="Chat history storage unavailable") from error
    try:
        results = qwenMax('.', prompt, session_id=session_id, response_format=response_format, user_message=user_message)
    except FinalAnswerFormatError as error:
        return JSONResponse(status_code=502, content={
            "success": False, "result": None, "status_code": 502,
            "error": error.public_message, "session_id": session_id,
        })
    except ContextBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ChatSessionDeletedError as error:
        raise HTTPException(status_code=410, detail=str(error)) from error
    if not results:
        return user_Response_structure(
            success=False,
            result=None,
            status_code=200,
            error="server error",
            session_id=session_id,
        )
    return user_Response_structure(
    success= True,
    result = results,
    status_code=200,
    error=None,
    session_id=session_id,
    )


def chat_history_response(callback):
    try:
        store = getattr(app.state, "chat_history", None) or ChatHistoryStore()
        return {"success": True, "result": callback(store), "error": None, "status_code": 200}
    except KeyError as error:
        raise HTTPException(status_code=404, detail="Chat session not found") from error
    except ContextBusyError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except sqlite3.Error as error:
        raise HTTPException(status_code=503, detail="Chat history storage unavailable") from error
    except OSError as error:
        raise HTTPException(status_code=503, detail="Chat session files unavailable; retry the same request") from error


class ChatSessionUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=120)


@app.get("/agent/chat/sessions", tags=["Chat history"])
def chat_sessions(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)):
    return chat_history_response(lambda store: store.sessions(limit, offset))


@app.get("/agent/chat/sessions/{session_id}/activity", tags=["Chat history"])
def chat_activity(session_id: str):
    """What the session's running turn is doing now: idle, thinking, or the tool it runs (name only)."""
    try:
        validate_session_id(session_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"success": True, "result": agent_activity.current(session_id), "error": None, "status_code": 200}


@app.get("/agent/chat/sessions/{session_id}/history", tags=["Chat history"])
def chat_history(session_id: str, limit: int = Query(20, ge=1, le=50), before_id: int | None = Query(None, ge=1)):
    return chat_history_response(lambda store: store.history(session_id, limit, before_id))


@app.patch("/agent/chat/sessions/{session_id}", tags=["Chat history"])
def rename_chat_session(session_id: str, req: ChatSessionUpdate):
    return chat_history_response(lambda store: store.rename_session(session_id, req.title))


@app.delete("/agent/chat/sessions/{session_id}", tags=["Chat history"])
def delete_chat_session(session_id: str):
    def remove(store):
        result = store.delete_session(session_id)
        app.state.automation_store.cancel_session_replies(session_id)
        return result
    return chat_history_response(remove)


@app.get("/agent/user/visualizations", response_model=list[ChatTurnResult])
def user_visualizations(session_id: str, limit: int = Query(20, ge=1, le=100),
                        before_turn_id: int | None = Query(None, ge=1)):
    try:
        store = getattr(app.state, "chat_history", None) or ChatHistoryStore()
        store.ensure_active(session_id)
        return read_visualization_history(session_id, limit=limit, before_turn_id=before_turn_id)
    except ChatSessionDeletedError as error:
        raise HTTPException(status_code=410, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except sqlite3.Error as error:
        raise HTTPException(status_code=503, detail="Chat history storage unavailable") from error


@app.post("/agent/ocr-intent", response_model=OCRIntent_Response_structure, status_code=status.HTTP_200_OK)
def ocr_intent_request(req: OCRIntent_request_structure):
    try:
        result = judge_ocr_intent(
            msgid=req.msgid,
            ocr_text=req.ocr_text,
            image_path=req.image_path,
            enrich_existing=req.enrich_existing,
            category_options=req.category_options,
        )

        return OCRIntent_Response_structure(
            success=True,
            result=result,
            status_code=200,
            error=None
        )

    except Exception as e:
        return OCRIntent_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e)
        )

@app.post("/agent/mail-classification", response_model=MailClassification_Response_structure, status_code=status.HTTP_200_OK)
def mail_classification_request(req: MailClassification_request_structure):
    try:
        result = run_mail_classification_agent(
            msgid=req.msgid,
            source_type=req.source_type or "gmail",
            mail_subject=req.mail_subject or "",
            mail_snippet=req.mail_snippet or "",
            mail_body=req.mail_body or "",
            mail_from=req.mail_from or "",
            mail_time=req.mail_time or "",
            amount=req.amount,
            shop_name=req.shop_name or "",
            user_tags=req.user_tags or [],
            project_directory="."
        )

        return MailClassification_Response_structure(
            success=bool(result.get("success")),
            result=result.get("result"),
            raw_result=result.get("raw_result"),
            status_code=200 if result.get("success") else 500,
            error=result.get("error")
        )

    except Exception as e:
        return MailClassification_Response_structure(
            success=False,
            result=None,
            raw_result=None,
            status_code=500,
            error=str(e)
        )

# Model, web-search and vector-store endpoints are plain functions: FastAPI runs them in its thread pool, so one
# long classification (often tens of seconds) no longer blocks /agent/health, chat or other requests.
@app.post("/agent/dealing-data/classify-write", response_model=DealingDataClassification_Response_structure, status_code=status.HTTP_200_OK)
def dealing_data_classification_request(req: DealingDataClassification_request_structure):
    try:
        result = run_dealing_data_classification_agent(
            msgid=req.msgid,
            mail_text=req.mail_text,
            raw_shop_name=req.raw_shop_name or "",
            price=req.price,
            iso_time=req.iso_time or "",
            CurrencyTypeNumber=req.CurrencyTypeNumber,
            AccountNumber=req.AccountNumber,
            category_options=req.category_options or [],
            project_directory="."
        )

        return DealingDataClassification_Response_structure(
            success=bool(result.get("success")),
            result=result.get("result"),
            raw_result=result.get("raw_result"),
            status_code=200 if result.get("success") else 500,
            error=result.get("error")
        )

    except Exception as e:
        return DealingDataClassification_Response_structure(
            success=False,
            result=None,
            raw_result=None,
            status_code=500,
            error=str(e)
        )

@app.post("/vectorDB/search", response_model=ClassificationMemorySearch_Response_structure, status_code=status.HTTP_200_OK)
def classification_memory_search_shop(req: ClassificationMemorySearch_request_structure):
    try:
        result = search_classification_by_raw_shop_name(
            raw_shop_name=req.raw_shop_name,
            limit=req.limit or 5,
            max_distance=req.max_distance if req.max_distance is not None else 0.35,
            item_name=req.item_name or "",
            item_type=req.item_type or "",
            case_max_distance=req.case_max_distance if req.case_max_distance is not None else 0.35,
        )
        if not result.get("matched"):
            result = None

        return ClassificationMemorySearch_Response_structure(
            success=True,
            result=result,
            status_code=200,
            error=None,
        )

    except Exception as e:
        return ClassificationMemorySearch_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e),
        )


@app.put("/vectorDB/classification-case/sync-category", response_model=ClassificationMemorySearch_Response_structure, status_code=status.HTTP_200_OK)
def classification_case_sync_category(req: ClassificationCaseCategorySync_request_structure):
    try:
        case_store = classification_case_memory_store()
        merchant_store = merchant_memory_store()
        old_main = str(req.old_main_category or "").strip()
        old_sub = str(req.old_sub_category or "").strip()
        old_detail = str(req.old_detail_category or "").strip()
        new_main = str(req.new_main_category or "").strip()
        new_sub = str(req.new_sub_category or "").strip()
        new_detail = str(req.new_detail_category or "").strip()
        old_shop = str(req.old_shop_name or "").strip()
        new_shop = str(req.new_shop_name or "").strip()
        raw_changed_fields = [str(item) for item in (req.changed_fields or [])]

        def normalize_field_name(value):
            return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())

        field_aliases = {
            "shopname": "ShopName",
            "canonicalshopname": "ShopName",
            "rawshopname": "ShopName",
            "maincategory": "MainCategory",
            "subcategory": "SubCategory",
            "detailcategory": "detail_category",
        }
        changed_fields = {
            field_aliases.get(normalize_field_name(field), field)
            for field in raw_changed_fields
        }
        category_changed = bool({"MainCategory", "SubCategory", "detail_category"} & changed_fields)
        shop_name_changed = "ShopName" in changed_fields

        def normalize(value):
            return re.sub(r"\s+", " ", str(value or "").strip()).casefold()

        target_shop = normalize(old_shop)

        def row_matches_shop(row):
            if not target_shop:
                return False
            row_values = {
                normalize(row.get("raw_shop_name")),
                normalize(row.get("canonical_shop_name")),
                normalize(row.get("normalized_shop_name")),
            }
            return target_shop in row_values

        def row_matches_old_category(row):
            return (
                str(row.get("main_category") or "").strip() == old_main
                and str(row.get("sub_category") or "").strip() == old_sub
                and str(row.get("detail_category") or "").strip() == old_detail
            )

        if not old_main or not old_sub or not new_main or not new_sub:
            return ClassificationMemorySearch_Response_structure(
                success=False,
                result=None,
                status_code=400,
                error="old/new main_category and sub_category are required",
            )

        if not target_shop:
            return ClassificationMemorySearch_Response_structure(
                success=True,
                result={
                    "matched_count": 0,
                    "updated_count": 0,
                    "matched_merchant_count": 0,
                    "updated_merchant_count": 0,
                    "changed_fields": sorted(changed_fields),
                    "target_shop": target_shop,
                    "skipped_reason": "old_shop_name is required for vector sync",
                },
                status_code=200,
                error=None,
            )

        limit = max(1, int(req.limit or 50000))
        rows = case_store.search(where=where_eq("main_category", old_main), limit=limit)
        matched_rows = [
            row for row in rows
            if row_matches_old_category(row)
            and row_matches_shop(row)
        ]

        embedding_client = None
        updated_rows = []
        target_user_confirmed = True
        for row in matched_rows:
            update_values = {
                "user_confirmed": target_user_confirmed,
            }
            if "MainCategory" in changed_fields:
                update_values["main_category"] = new_main
            if "SubCategory" in changed_fields:
                update_values["sub_category"] = new_sub
            if "detail_category" in changed_fields:
                update_values["detail_category"] = new_detail
            if shop_name_changed and new_shop:
                update_values["canonical_shop_name"] = new_shop

            if shop_name_changed:
                semantic_embedding_text = " ".join(
                    part for part in [
                        str(row.get("item_name") or "").strip(),
                        str(row.get("item_type") or "").strip(),
                    ]
                    if part
                ).strip()
                if not semantic_embedding_text:
                    semantic_embedding_text = new_shop or row.get("canonical_shop_name") or row.get("raw_shop_name") or ""
                if semantic_embedding_text and semantic_embedding_text != row.get("semantic_embedding_text"):
                    if embedding_client is None:
                        embedding_client = get_embedding_client()
                    update_values["semantic_embedding_text"] = semantic_embedding_text
                    update_values["vector"] = embedding_client.embed_text(semantic_embedding_text)

            updated = case_store.update(
                row.get("case_id"),
                update_values,
            )
            if updated and bool(updated.get("user_confirmed")) != target_user_confirmed:
                updated = case_store.update(
                    row.get("case_id"),
                    {"user_confirmed": target_user_confirmed},
                )
            if updated:
                updated_rows.append({
                    "case_id": updated.get("case_id"),
                    "raw_shop_name": updated.get("raw_shop_name"),
                    "canonical_shop_name": updated.get("canonical_shop_name"),
                    "main_category": updated.get("main_category"),
                    "sub_category": updated.get("sub_category"),
                    "detail_category": updated.get("detail_category"),
                    "user_confirmed": updated.get("user_confirmed"),
                })

        updated_merchants = []
        matched_merchants = []
        if shop_name_changed and new_shop:
            merchant_rows = merchant_store.search(limit=limit)
            matched_merchants = [row for row in merchant_rows if row_matches_shop(row)]
            for row in matched_merchants:
                merchant_embedding_text = " ".join(
                    part for part in [
                        str(row.get("raw_shop_name") or "").strip(),
                        str(row.get("normalized_shop_name") or "").strip(),
                        new_shop,
                    ]
                    if part
                ).strip()
                update_values = {
                    "canonical_shop_name": new_shop,
                    "user_confirmed": target_user_confirmed,
                }
                if merchant_embedding_text:
                    if embedding_client is None:
                        embedding_client = get_embedding_client()
                    update_values["merchant_embedding_text"] = merchant_embedding_text
                    update_values["vector"] = embedding_client.embed_text(merchant_embedding_text)

                updated = merchant_store.update(row.get("merchant_record_id"), update_values)
                if updated and bool(updated.get("user_confirmed")) != target_user_confirmed:
                    updated = merchant_store.update(
                        row.get("merchant_record_id"),
                        {"user_confirmed": target_user_confirmed},
                    )
                if updated:
                    updated_merchants.append({
                        "merchant_record_id": updated.get("merchant_record_id"),
                        "raw_shop_name": updated.get("raw_shop_name"),
                        "canonical_shop_name": updated.get("canonical_shop_name"),
                        "user_confirmed": updated.get("user_confirmed"),
                    })

        return ClassificationMemorySearch_Response_structure(
            success=True,
            result={
                "matched_count": len(matched_rows),
                "updated_count": len(updated_rows),
                "matched_merchant_count": len(matched_merchants),
                "updated_merchant_count": len(updated_merchants),
                "changed_fields": sorted(changed_fields),
                "target_shop": target_shop,
                "old_category": {
                    "main_category": old_main,
                    "sub_category": old_sub,
                    "detail_category": old_detail,
                },
                "match_rule": "old_shop_name + old_main_category + old_sub_category + old_detail_category",
                "new_category": {
                    "main_category": new_main,
                    "sub_category": new_sub,
                    "detail_category": new_detail,
                },
                "updated_rows": updated_rows[:50],
                "updated_rows_truncated": len(updated_rows) > 50,
                "updated_merchants": updated_merchants[:50],
                "updated_merchants_truncated": len(updated_merchants) > 50,
            },
            status_code=200,
            error=None,
        )

    except Exception as e:
        return ClassificationMemorySearch_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e),
        )


@app.post("/vectorDB/adr-memory", response_model=ClassificationMemorySearch_Response_structure, status_code=status.HTTP_200_OK)
def create_adr_memory(req: ADRMemoryCreate_request_structure):
    try:
        result = create_adr_memory_api(
            source_type=req.source_type or "gmail",
            source_id=req.source_id,
            amount=req.amount,
            shop_name=req.shop_name or "",
            time=req.time or "",
            body=req.body or "",
            mail_address=req.mail_address or "",
            mail_subject=req.mail_subject or "",
            mail_snippet=req.mail_snippet or "",
        )

        return ClassificationMemorySearch_Response_structure(
            success=bool(result.get("success")),
            result=result.get("result"),
            status_code=200 if result.get("success") else 500,
            error=result.get("error"),
        )

    except Exception as e:
        return ClassificationMemorySearch_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e),
        )


@app.post("/vectorDB/adr-memory/batch", response_model=ClassificationMemorySearch_Response_structure, status_code=status.HTTP_200_OK)
def create_adr_memory_batch(req: ADRMemoryBatchCreate_request_structure):
    try:
        items = [
            item.model_dump() if hasattr(item, "model_dump") else item.dict()
            for item in req.items
        ]
        result = create_adr_memory_batch_api(
            items=items,
            batch_max_tokens=req.batch_max_tokens,
            batch_max_inputs=req.batch_max_inputs,
            initialization=req.initialization,
        )

        return ClassificationMemorySearch_Response_structure(
            success=bool(result.get("success")),
            result=result.get("result"),
            status_code=200 if result.get("success") else 500,
            error=result.get("error"),
        )

    except Exception as e:
        return ClassificationMemorySearch_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e),
        )


@app.get("/vectorDB/adr-memory/source", response_model=ClassificationMemorySearch_Response_structure)
def read_adr_memory_source(source_id: str = Query(min_length=1, max_length=1024)):
    try:
        row = get_adr_memory_by_source(source_id)
        return ClassificationMemorySearch_Response_structure(
            success=True, result=row, status_code=200, error=None,
        )
    except Exception as error:
        raise HTTPException(status_code=503, detail="Could not read evidence storage") from error


@app.post("/vectorDB/adr-memory/search", response_model=ClassificationMemorySearch_Response_structure, status_code=status.HTTP_200_OK)
def search_adr_memory(req: ADRMemorySearch_request_structure):
    try:
        result = search_adr_memory_by_text(
            query_text=req.query_text,
            limit=req.limit or 3,
            exclude_source_ids=req.exclude_source_ids,
        )

        return ClassificationMemorySearch_Response_structure(
            success=bool(result.get("success")),
            result=result.get("result"),
            status_code=200 if result.get("success") else 500,
            error=result.get("error"),
        )

    except Exception as e:
        return ClassificationMemorySearch_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e),
        )


@app.post("/vectorDB/adr-memory/list", response_model=ClassificationMemorySearch_Response_structure, status_code=status.HTTP_200_OK)
def list_adr_memory(req: ADRMemoryList_request_structure):
    try:
        result = list_adr_memory_by_source_type(
            source_type=req.source_type or "ocr",
            limit=req.limit or 1000,
        )

        return ClassificationMemorySearch_Response_structure(
            success=bool(result.get("success")),
            result=result.get("result"),
            status_code=200 if result.get("success") else 500,
            error=result.get("error"),
        )

    except Exception as e:
        return ClassificationMemorySearch_Response_structure(
            success=False,
            result=None,
            status_code=500,
            error=str(e),
        )


@app.get("/prompts", status_code=status.HTTP_200_OK)
async def get_prompt_list(language: Literal["zh", "ja", "en"] | None = None):
    try:
        result = list_prompts(language)
        return {
            "success": True,
            "result": result,
            "status_code": 200,
            "error": None
        }
    except Exception as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }


@app.get("/prompts/{prompt_name}", status_code=status.HTTP_200_OK)
async def get_single_prompt(prompt_name: str, language: Literal["zh", "ja", "en"] | None = None):
    try:
        result = get_prompt(prompt_name, language)
        return {
            "success": True,
            "result": result,
            "status_code": 200,
            "error": None
        }
    except Exception as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }


@app.put("/prompts/{prompt_name}", status_code=status.HTTP_200_OK)
async def update_single_prompt(prompt_name: str, req: Prompt_update_request_structure,
                               language: Literal["zh", "ja", "en"] | None = None):
    try:
        result = update_prompt(prompt_name, req.model_dump(exclude_none=True), language)
        return {
            "success": True,
            "result": result,
            "status_code": 200,
            "error": None
        }
    except Exception as e:
        return {
            "success": False,
            "result": None,
            "status_code": 500,
            "error": str(e)
        }

"""What each chat session's running turn is doing right now, for the chat panel's status line.

The ReAct loop reports every step here (thinking, or the name of the tool it runs); the chat panel polls
GET /agent/chat/sessions/{session_id}/activity while it waits. Kept in memory only and holds no tool
arguments or results, just the step, the phase and the names of the tools used so far.
"""

from datetime import datetime, timezone
import threading

_lock = threading.Lock()
_running = {}


def session_key(context_manager):
    """The chat session a context belongs to; None for contexts that are not a saved chat."""
    path = getattr(context_manager, "path", None)
    return path.stem.removeprefix("session_") if path is not None else None


def report(key, phase, *, step, tool=None):
    if key is None:
        return
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        previous = _running.get(key, {})
        # Local tools finish in milliseconds, so the panel also shows the tools this turn has used so far.
        tools = (list(previous.get("tools", ())) + ([tool] if phase == "tool" and tool else []))[-20:]
        _running[key] = {"phase": phase, "tool": tool, "step": step, "tools": tools, "since": now,
                         "started_at": previous.get("started_at") or now}
    print(f"\n\n[{key}] 第 {step} 步：" + (f"调用工具 {tool}" if phase == "tool" else "思考中"))


def finish(key):
    if key is not None:
        with _lock:
            _running.pop(key, None)


def current(session_id):
    with _lock:
        state = _running.get(session_id)
        if not state:
            return {"phase": "idle", "tool": None, "step": 0, "tools": [], "since": None, "started_at": None}
        return {**state, "tools": list(state["tools"])}

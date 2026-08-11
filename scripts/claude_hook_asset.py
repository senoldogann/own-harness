import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

DENY_JSON = json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "own-harness policy denied tool"
    }
})


def main() -> int:
    stdin_json = ""
    if not sys.stdin.isatty():
        stdin_json = sys.stdin.read()
    raw_input = stdin_json or os.environ.get("CLAUDE_HOOK_TOOL_INPUT", "")
    event = os.environ.get("CLAUDE_HOOK_EVENT", "")
    tool = os.environ.get("CLAUDE_HOOK_TOOL_NAME", "")
    command = ""
    tool_use_id = ""
    duration_ms = 0
    exit_code = None
    if raw_input:
        try:
            data = json.loads(raw_input)
        except json.JSONDecodeError:
            data = {}
        if isinstance(data, dict):
            event = str(data.get("hook_event_name") or event)
            tool = tool or str(data.get("tool_name") or data.get("tool") or "")
            tool_use_id = str(data.get("tool_use_id") or "")
            duration_ms = parse_int(str(data.get("duration_ms") or "0"))
            if event == "PostToolUseFailure":
                exit_code = failure_exit_code(str(data.get("error") or ""))
            tool_input = data.get("tool_input") or {}
            if isinstance(tool_input, str):
                try:
                    tool_input = json.loads(tool_input)
                except json.JSONDecodeError:
                    tool_input = {}
            if isinstance(tool_input, dict):
                command = str(tool_input.get("command") or "")
            if not command:
                command = str(data.get("command") or "")
    if not command:
        command = os.environ.get("CLAUDE_HOOK_COMMAND", "")
    if not tool:
        tool = "Bash"
    if not command:
        return 0
    if event == "PostToolUse" and exit_code is None:
        exit_code = 0
    if event != "PreToolUse" and duration_ms == 0:
        duration_ms = elapsed_duration_ms(tool_use_id)

    base_url = os.environ.get("HARNESS_INGEST_URL", "")
    if base_url:
        result = post_ingest(base_url, tool, command, event, tool_use_id, exit_code, duration_ms)
    else:
        result = run_cli_fallback(tool, command, event)
    if result == 0 and event == "PreToolUse":
        record_start_time(tool_use_id)
    return result


def post_ingest(
    base_url: str,
    tool: str,
    command: str,
    event: str,
    tool_use_id: str,
    exit_code: int | None,
    duration_ms: int
) -> int:
    headers = {"content-type": "application/json"}
    auth_token = os.environ.get("HARNESS_AUTH_TOKEN", "")
    if auth_token:
        headers["authorization"] = f"Bearer {auth_token}"
    payload = {
        "tool": tool,
        "command": command,
        "sessionId": os.environ.get("HARNESS_SESSION_ID", ""),
        "agent": os.environ.get("HARNESS_AGENT", "claude"),
        "projectHash": os.environ.get("HARNESS_PROJECT_HASH", ""),
        "exitCode": exit_code,
        "durationMs": duration_ms
    }
    if tool_use_id:
        payload["hookEvent"] = event or "PreToolUse"
        payload["toolUseId"] = tool_use_id
    request = urllib.request.Request(
        base_url.rstrip("/") + "/api/v1/ingest",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            return 0
    except urllib.error.HTTPError as error:
        if error.code == 403 and event == "PreToolUse":
            print(DENY_JSON)
            return 0
        if error.code == 403:
            print(
                f"own-harness deny signal for {tool} ignored because hook event is not PreToolUse: {event or 'unknown'}",
                file=sys.stderr
            )
            return 3
        print(f"own-harness ingest failed for {tool}: HTTP {error.code}", file=sys.stderr)
        return 3
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"own-harness ingest failed for {tool}: {error}", file=sys.stderr)
        return 3


def run_cli_fallback(tool: str, command: str, event: str) -> int:
    env = dict(os.environ)
    env["HARNESS_TOOL_EXIT_CODE"] = env.get("HARNESS_TOOL_EXIT_CODE", "0")
    result = subprocess.run(
        ["harness", "ingest", tool, command],
        env=env,
        capture_output=True,
        text=True
    )
    if result.returncode == 0:
        return 0
    output = result.stdout + result.stderr
    if event == "PreToolUse" and "POLICY_DENIED" in output:
        print(DENY_JSON)
        return 0
    if "POLICY_DENIED" in output:
        print(
            f"own-harness deny signal ignored because hook event is not PreToolUse: {event or 'unknown'}",
            file=sys.stderr
        )
        return 3
    print(output, file=sys.stderr)
    return 3


def parse_int(value: str) -> int:
    try:
        return int(value)
    except ValueError:
        return 0


def failure_exit_code(error: str) -> int:
    match = re.search(r"(?:status|exit) code\s+(\d+)", error, re.IGNORECASE)
    if match is None:
        return 1
    return int(match.group(1))


def timing_path(tool_use_id: str) -> Path | None:
    if not tool_use_id:
        return None
    session_id = os.environ.get("HARNESS_SESSION_ID", "")
    digest = hashlib.sha256(f"{session_id}\0{tool_use_id}".encode("utf-8")).hexdigest()
    root = Path(os.environ.get("HARNESS_HOOK_STATE_DIR", "~/.own-harness/hook-timing")).expanduser()
    return root / digest


def record_start_time(tool_use_id: str) -> None:
    path = timing_path(tool_use_id)
    if path is None:
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(str(time.time_ns()), encoding="utf-8")
    path.chmod(0o600)


def elapsed_duration_ms(tool_use_id: str) -> int:
    path = timing_path(tool_use_id)
    if path is None or not path.exists():
        return 0
    started_ns = parse_int(path.read_text(encoding="utf-8").strip())
    path.unlink()
    return max(0, (time.time_ns() - started_ns) // 1_000_000)


if __name__ == "__main__":
    sys.exit(main())

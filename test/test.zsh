#!/bin/zsh -f
# Synthetic hook payloads against isolated state and temp directories; does not start a client.
bin=${0:A:h:h}/bin/agent-inbox
export XDG_STATE_HOME=$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-test.XXXXXX")
export XDG_STATE_HOME=${XDG_STATE_HOME:A}
trap 'rm -rf $XDG_STATE_HOME' EXIT
export TMPDIR=$XDG_STATE_HOME/tmp
mkdir -p $TMPDIR
root=$TMPDIR/agent-inbox-$UID
unset AGENT_INBOX CODEX_SESSION_ID OPENCODE_SESSION_ID
integer pass_n=0 fail_n=0
check() {
  if eval "$2"; then (( pass_n++ )); print -r -- "ok    $1"
  else (( fail_n++ )); print -r -- "FAIL  $1"; print -r -- "      $2"; fi
}
hook() { print -r -- "{\"session_id\":\"$1\",\"hook_event_name\":\"$2\",\"cwd\":\"$3\"}" }
context() { jq -r '.hookSpecificOutput.additionalContext' }

envfile=$XDG_STATE_HOME/env
hook s1 SessionStart | CLAUDE_ENV_FILE=$envfile $bin session-start
check 'session-start exports AGENT_INBOX through CLAUDE_ENV_FILE' '[[ $(<$envfile) == "export AGENT_INBOX=$root/s1" && -d $root/s1 ]]'
source $envfile

$bin post 'first'; print -r -- $'second\nwith a newline' | $bin post; $bin post ''
check 'post takes arguments or stdin; an empty message is dropped' '[[ $(print -l $root/s1/*.msg | wc -l) -eq 2 ]]'

out=$(hook s1 PostToolBatch | $bin drain)
check 'drain answers with the event that ran it' '[[ $(jq -r .hookSpecificOutput.hookEventName <<<$out) == PostToolBatch ]]'
check 'drain delivers every message in post order' '[[ $(context <<<$out) == *$'"'"'first\n\nsecond\nwith a newline'"'"' ]]'
check 'a drained queue is empty' '[[ -z $(hook s1 PostToolBatch | $bin drain) ]]'

hook s2 SessionStart | CLAUDE_ENV_FILE=/dev/null $bin session-start
AGENT_INBOX=$root/s2 $bin post 'for s2'
check 'sessions do not see each other'"'"'s messages' '[[ -z $(hook s1 PostToolBatch | $bin drain) && $(hook s2 UserPromptSubmit | $bin drain | context) == *"for s2" ]]'

check 'post outside a session exits 1' '! env -u AGENT_INBOX $bin post hi'
check 'post refuses a directory outside the inbox root' '! AGENT_INBOX=/tmp/elsewhere $bin post hi'

# stdin has no argv size limit; delivery must not turn a large message into jq argv.
large=${(l:300000::x:)}
print -rn -- $large | AGENT_INBOX=$root/s2 $bin post
out=$(hook s2 UserPromptSubmit | $bin drain)
check 'stdin messages larger than the OS argument limit survive delivery' '[[ $(context <<<$out) == *$large ]]'

for i in {1..50}; do $bin post "m$i"; done
for k in 1 2; do (hook s1 PostToolBatch | $bin drain >$XDG_STATE_HOME/d$k) & done; wait
got=$(cat $XDG_STATE_HOME/d1 $XDG_STATE_HOME/d2 | context | grep -E '^m[0-9]+$')
check 'concurrent drains deliver each message exactly once' '[[ $(print -r -- $got | wc -l) -eq 50 && $(print -r -- $got | sort -u | wc -l) -eq 50 ]]'

hook ../../x SessionStart | CLAUDE_ENV_FILE=$envfile.bad $bin session-start
check 'a path traversal session id is ignored' '[[ ! -e $envfile.bad && ! -e $XDG_STATE_HOME/x ]]'

mkdir -p $root/stale && touch -t 202001010000 $root/stale
hook s3 SessionStart | CLAUDE_ENV_FILE=/dev/null $bin session-start
check 'session-start removes queues untouched for 7 days' '[[ ! -e $root/stale && -d $root/s3 ]]'

hook s1 SessionEnd | $bin session-end
check 'session-end removes the queue' '[[ ! -e $root/s1 ]]'
unset AGENT_INBOX

# Codex 0.162.1 core/src/exec_env.rs injects CODEX_SESSION_ID for the root session,
# including subagent commands. hook_runtime.rs uses that same ID in hook payloads.
hook codex_1 SessionStart | $bin session-start
hook codex_2 SessionStart | $bin session-start
CODEX_SESSION_ID=codex_1 $bin post 'for codex 1'
CODEX_SESSION_ID=codex_2 $bin post 'for codex 2'
check 'Codex sessions in the same cwd stay isolated' \
  '[[ $(hook codex_1 PostToolUse | $bin drain | context) == *"for codex 1" && $(hook codex_2 UserPromptSubmit | $bin drain | context) == *"for codex 2" ]]'
check 'cwd alone never identifies a session' '! $bin post orphan'

# Claude Code exports an explicit queue; it wins over inherited runtime identities.
AGENT_INBOX=$root/codex_1 CODEX_SESSION_ID=codex_2 $bin post explicit
check 'an explicit inbox takes precedence over native session IDs' \
  '[[ $(hook codex_1 PostToolBatch | $bin drain | context) == *explicit && -z $(hook codex_2 PostToolUse | $bin drain) ]]'
check 'post rejects a traversal through an explicit inbox path' \
  '! AGENT_INBOX=$root/../../escape $bin post hi'

hook codex_1 SessionEnd | $bin session-end
check 'a late writer cannot recreate a closed queue' \
  '! CODEX_SESSION_ID=codex_1 $bin post late && [[ ! -e $root/codex_1 ]]'

touch -t 202001010000 $root/codex_2
hook codex_2 SessionStart | $bin session-start
check 'resuming a stale session refreshes it before garbage collection' '[[ -d $root/codex_2 ]]'

print
print -r -- "$pass_n passed, $fail_n failed"
(( fail_n == 0 ))

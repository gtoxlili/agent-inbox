#!/bin/zsh -f
# Synthetic hook payloads against a temporary XDG_STATE_HOME; does not start Claude Code.
bin=${0:A:h:h}/bin/agent-inbox
export XDG_STATE_HOME=$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-test.XXXXXX")
trap 'rm -rf $XDG_STATE_HOME' EXIT
root=$XDG_STATE_HOME/agent-inbox
unset AGENT_INBOX
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

for i in {1..50}; do $bin post "m$i"; done
for k in 1 2; do (hook s1 PostToolBatch | $bin drain >$XDG_STATE_HOME/d$k) & done; wait
got=$(cat $XDG_STATE_HOME/d1 $XDG_STATE_HOME/d2 | context | grep -E '^m[0-9]+$')
check 'concurrent drains deliver each message exactly once' '[[ $(print -r -- $got | wc -l) -eq 50 && $(print -r -- $got | sort -u | wc -l) -eq 50 ]]'

hook ../../x SessionStart | CLAUDE_ENV_FILE=$envfile.bad $bin session-start
check 'a session id outside [A-Za-z0-9-] is ignored' '[[ ! -e $envfile.bad && ! -e $XDG_STATE_HOME/x ]]'

mkdir -p $root/stale && touch -t 202001010000 $root/stale
hook s3 SessionStart | CLAUDE_ENV_FILE=/dev/null $bin session-start
check 'session-start removes queues untouched for 7 days' '[[ ! -e $root/stale && -d $root/s3 ]]'

hook s1 SessionEnd | $bin session-end
check 'session-end removes the queue' '[[ ! -e $root/s1 ]]'
unset AGENT_INBOX

# cwd mapping: Codex and opencode cannot rely on AGENT_INBOX reaching every child process
work=$XDG_STATE_HOME/work; mkdir -p $work/sub
hook thr_c1 SessionStart $work | $bin session-start >/dev/null
check 'session ids with underscores are accepted (Codex thr_* ids)' '[[ -d $root/thr_c1 ]]'
check 'post without AGENT_INBOX resolves the queue through the cwd mapping' \
  '[[ $(cd $work && $bin post via-cwd && cd sub && $bin post via-subdir; hook thr_c1 PostToolUse | $bin drain | context) == *$'"'"'via-cwd\n\nvia-subdir'"'"' ]]'
check 'session-end removes the cwd mapping' \
  '{ hook thr_c1 SessionEnd $work | $bin session-end; [[ ! -e $root/thr_c1 && -z $(print -l $root/.by-cwd/*(N)) ]] }'

hook c2 SessionStart $work | $bin session-start >/dev/null
hook c3 SessionStart $work | $bin session-start >/dev/null   # second session, same cwd
hook c2 SessionEnd $work | $bin session-end
(cd $work && $bin post after-c2-ended)
check 'an ended session does not take the mapping of a later session with the same cwd' \
  '[[ $(hook c3 UserPromptSubmit | $bin drain | context) == *after-c2-ended* ]]'

check 'post with no live mapping exits 1 even below a once-mapped cwd' \
  '{ hook c3 SessionEnd $work | $bin session-end; (cd $work/sub && ! $bin post orphan) }'

print
print -r -- "$pass_n passed, $fail_n failed"
(( fail_n == 0 ))

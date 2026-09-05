---
name: learn
description: "ALWAYS use when the user says 'teach me …', 'make me a course/lesson/class/tutorial', 'I want to learn …', asks to turn documents into a course, OR asks about a Cue Learn course they already have ('my course', 'quiz me on my course', 'help me go deeper on <course>'): generates or READS a Cue Learn interactive course — an AI-taught classroom with narrated slides, quizzes, and simulations. 'Teach me X' means BUILD THE COURSE (optionally with a short chat primer alongside), not a chat lecture — and 'teach me X in N slides/minutes' is STILL this skill (the number is course length), never the app/deck builder: a deck cannot speak or take questions. Questions about an existing course mean FETCH ITS CONTENT and tutor from it. Skip only for quick factual questions where a course would be overkill."
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🎓"
  vellum:
    display-name: "Cue Learn"
    category: "apps"
    feature-flag: "learn-app"
    activation-hints:
      - "User says 'teach me X' — this IS the course trigger; do not turn it into a chat lecture"
      - "'Teach me X in N slides' or 'in N minutes' is a COURSE with that length — never the app/deck builder; decks don't teach aloud"
      - "User says 'I want to learn X', 'make me a course/lesson/class/tutorial on X', or asks to turn a document into a course"
      - "User asks to explain a big topic 'properly', 'step by step', or 'like a class' — offer a Learn course alongside your chat answer"
      - "User references an earlier Cue Learn course and wants another one"
      - "User asks about a course they are taking — 'my course', 'quiz me on it', 'what should I explore next' — FETCH the course content (see 'Tutoring from an existing course') instead of saying you cannot see it"
    avoid-when:
      - "The user wants a quick factual answer, a summary, or a document — answer in chat; a course is overkill"
      - "LEARN_UPSTREAM_URL is not present in the environment — Learn is not deployed for this Cue; say so instead of erroring"
---

Generate an interactive course on the user's topic in **Cue Learn** (the
classroom surface under **Learn** in the sidebar), then hand back a link that
opens the finished classroom inside Cue.

## Preconditions

`$LEARN_UPSTREAM_URL` being present in your bash environment is the signal
that Learn is deployed on this Cue. If it is empty, tell the user Learn isn't
set up yet and stop. Make the actual calls through the local gateway at
`$INTERNAL_GATEWAY_BASE_URL` (loopback callers are trusted and the gateway
attaches the sidecar's access credentials) — never call `$LEARN_UPSTREAM_URL`
directly; the sidecar rejects unauthenticated peers.

## Pipeline

1. **Compose the requirement.** Turn the user's ask into one clear course
   brief: topic, depth ("from scratch" vs advanced), target length if given
   (e.g. "in 20 minutes"), language if the user isn't writing English. One or
   two sentences is ideal — the Learn pipeline does its own curriculum design.

2. **Materials (optional).** If the user wants the course built from their
   document(s): read the file(s) with your file tools, concatenate the text,
   and truncate to ~80,000 characters. Pass it as `pdfContent`. Skip this
   entirely for topic-only courses.

3. **Submit the job — the payload write and the POST are ONE bash call.**
   Temp files do NOT survive from one bash call to the next (calls can run in
   fresh contexts, and an approval pause can sit between them) — a
   `curl -d @file` issued in a later call than the file's write fails with
   `curl: option -d: error encountered when reading a file`. So the heredoc
   AND the curl below are a single command block in a single bash invocation;
   NEVER split them into separate calls. Do not inline the JSON with
   `-d '{...}'` either — a single-quoted inline body breaks on any apostrophe
   in the brief. Always POST through `$INTERNAL_GATEWAY_BASE_URL`:

   ```bash
   cat > /tmp/learn-payload.json <<'EOF'
   {"requirement": "<the brief>", "enableTTS": true, "enableImageGeneration": true}
   EOF
   jq --arg cid "${__CONVERSATION_ID:-}" \
      'if $cid == "" then . else . + {"source":{"kind":"cue-chat","conversationId":$cid}} end' \
      /tmp/learn-payload.json |
   curl -s -X POST "$INTERNAL_GATEWAY_BASE_URL/learn/api/generate-classroom" \
     -H 'content-type: application/json' -d @-
   ```

   The quoted `<<'EOF'` delimiter means nothing in the payload is
   shell-expanded — your only job inside the heredoc is valid JSON (escape
   quotes and newlines in the brief and material text). The `jq` step stamps
   provenance (`source`) from `$__CONVERSATION_ID` — already in your bash
   env — so the course's Library card can link back to this chat, and it
   cleanly omits the block when the variable is empty. Add materials inside
   the heredoc as `"pdfContent": {"text": "<material text>", "images": []}` —
   an OBJECT, not a bare string. The response is
   `{ data: { jobId, pollUrl, ... } }` (or the same fields at the top level).
   A course takes **2–6 minutes**; tell the user generation has started and
   roughly how long it takes.

4. **Poll in SHORT bursts** — never one long-running command (the bash tool
   times out around 10 minutes and a timed-out poll strands the user with no
   verdict). Each poll call checks for at most ~2 minutes, then RETURNS, and
   you call it again — up to 4 bursts (~8 minutes total). `pollUrl` may carry
   an internal host, so rebuild it from `$INTERNAL_GATEWAY_BASE_URL` and the
   jobId (write the literal jobId into the command — shell variables, like
   temp files, do not survive between bash calls):

   ```bash
   for i in $(seq 1 8); do
     curl -s "$INTERNAL_GATEWAY_BASE_URL/learn/api/generate-classroom/<jobId>" |
       grep -qE '"status":"(succeeded|failed)"' && break
     sleep 14
   done
   curl -s "$INTERNAL_GATEWAY_BASE_URL/learn/api/generate-classroom/<jobId>"
   ```

   Keep this exact shape (pipe the status check straight into `grep`, then
   one final fetch) — capturing into a shell variable and `echo`-ing it
   makes the command prompt for approval instead of auto-running.

   Between bursts, relay `progress`/`message` in one short line. **If it is
   still running after ~8 minutes, do NOT keep polling and do NOT end with a
   question**: the job keeps running server-side and the finished course
   appears under Learn's Recent list on its own. Give the user the Learn
   link (relative: `/assistant/learn`) with a note that the course is
   still generating and will appear there in a few minutes. That is a
   COMPLETE answer.

5. **Deliver the link.** On success the result carries the classroom URL —
   take its **last path segment** as the classroom id. The user-facing link
   is always the RELATIVE path:

   ```
   /assistant/learn?p=/classroom/$CLASSROOM_ID
   ```

   Chat renders in the app, so the relative link opens in place and renders
   as a course card. NEVER prepend a host: do not paste the internal
   (`.internal`) URL, and if you don't know the instance's public origin, do
   not guess or "fall back" to any domain you remember — a wrong host sends
   the user off-site. Only when the link must leave the app (an email, an
   exported doc) prefix `$(assistant config get ingress.publicBaseUrl)`, and
   if that is empty, say the course is under **Learn** in the sidebar
   instead of linking.

   Reply with one short line about what the course covers (scene count if
   you have it) and that link as a markdown link titled with the course
   topic — it opens the classroom inside Cue's Learn surface, voice and all.

6. **On failure**, relay the job's `error` plainly and suggest retrying or
   narrowing the topic. Never leave the user with a spinner and no verdict.

## Tutoring from an existing course

When the user asks about a course they already have ("I'm taking my course on
X — quiz me / answer questions / what next"), do NOT say you can't see the
course. Every Cue Learn course is readable — chat-generated classrooms and
wizard-made courses alike:

1. **Find the course** — list BOTH catalogs and match the user's title
   (case-insensitive, partial match is fine):

   ```bash
   curl -s "$INTERNAL_GATEWAY_BASE_URL/learn/api/classroom-sources"
   curl -s "$INTERNAL_GATEWAY_BASE_URL/learn/api/stages"
   ```

   The first response's `catalog` is `[{id, name, sceneCount, createdAt}]`
   (chat-generated classrooms); the second's `stages` is
   `[{id, name, sceneCount, ...}]` (wizard/workbench courses).

2. **Fetch its content** — by which catalog matched. Each fetch+parse below
   is ONE bash call (the temp file does not survive between calls — same rule
   as step 3):

   ```bash
   # classroom catalog match:
   curl -s "$INTERNAL_GATEWAY_BASE_URL/learn/api/classroom?id=<id>" > /tmp/course.json &&
   jq -r '.classroom.scenes[] | "## " + .title,
          ([.actions[]? | select(.type=="speech") | .text] | join("\n"))' \
     /tmp/course.json

   # stages match (whole document: stage + scenes + outline):
   curl -s "$INTERNAL_GATEWAY_BASE_URL/learn/api/stages/<id>" > /tmp/course.json &&
   jq -r '.scenes[]? | "## " + (.title // .name // ""),
          ([.actions[]? | select(.type=="speech") | .text] | join("\n"))' \
     /tmp/course.json
   ```

   (Inspect the JSON if a shape differs — narration is the `"type":"speech"`
   action text either way.) Cap what you load into context (~60k chars), then
   tutor from it: answer questions grounded in what the course actually
   teaches, quiz scene by scene, or map what to explore next beyond its
   outline. Both kinds open at the same place — link back with the relative
   `/assistant/learn?p=/classroom/<id>` when pointing at a specific part.

3. **If the title is in neither catalog**, it may predate server-side
   storage. Say that honestly, offer to regenerate it as a fresh course
   ("teach me X" pipeline above), and still help from your own knowledge in
   the meantime.

## Notes

- One course per request — confirm before batch-generating several.
- The classroom keeps living under **Learn** in the sidebar; mention that the
  user can revisit and continue it there.
- Generation cost lands on the workspace ledger automatically (actor "learn");
  no need to track or mention cost unless asked.

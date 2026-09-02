---
name: learn
description: "ALWAYS use when the user says 'teach me …', 'make me a course/lesson/class/tutorial', 'I want to learn …', or asks to turn documents into a course: generates a Cue Learn interactive course — an AI-taught classroom with narrated slides, quizzes, and simulations — and links to it. 'Teach me X' means BUILD THE COURSE (optionally with a short chat primer alongside), not a chat lecture. Skip only for quick factual questions where a course would be overkill."
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🎓"
  vellum:
    display-name: "Cue Learn"
    category: "apps"
    feature-flag: "learn-app"
    activation-hints:
      - "User says 'teach me X' — this IS the course trigger; do not turn it into a chat lecture"
      - "User says 'I want to learn X', 'make me a course/lesson/class/tutorial on X', or asks to turn a document into a course"
      - "User asks to explain a big topic 'properly', 'step by step', or 'like a class' — offer a Learn course alongside your chat answer"
      - "User references an earlier Cue Learn course and wants another one"
    avoid-when:
      - "The user wants a quick factual answer, a summary, or a document — answer in chat; a course is overkill"
      - "LEARN_UPSTREAM_URL is not present in the environment — Learn is not deployed for this Cue; say so instead of erroring"
---

Generate an interactive course on the user's topic in **Cue Learn** (the
classroom surface under **Learn** in the sidebar), then hand back a link that
opens the finished classroom inside Cue.

## Preconditions

The Learn service address is in `$LEARN_UPSTREAM_URL` (already present in your
bash environment on deployments that run Learn). If it is empty, tell the user
Learn isn't set up on this Cue yet and stop — do not guess a URL.

## Pipeline

1. **Compose the requirement.** Turn the user's ask into one clear course
   brief: topic, depth ("from scratch" vs advanced), target length if given
   (e.g. "in 20 minutes"), language if the user isn't writing English. One or
   two sentences is ideal — the Learn pipeline does its own curriculum design.

2. **Materials (optional).** If the user wants the course built from their
   document(s): read the file(s) with your file tools, concatenate the text,
   and truncate to ~80,000 characters. Pass it as `pdfContent`. Skip this
   entirely for topic-only courses.

3. **Submit the job** (bash):

   ```bash
   curl -s -X POST "$LEARN_UPSTREAM_URL/learn/api/generate-classroom" \
     -H 'content-type: application/json' \
     -d '{"requirement": "<the brief>", "enableTTS": true, "enableImageGeneration": true}'
   ```

   Add `"pdfContent": "<material text>"` when you have materials (JSON-escape
   it — write the payload to a temp file with a heredoc and `-d @file` rather
   than inlining). The response is `{ data: { jobId, pollUrl, ... } }` (or the
   same fields at the top level). A course takes **2–6 minutes**; tell the
   user generation has started and roughly how long it takes.

4. **Poll in SHORT bursts** — never one long-running command (the bash tool
   times out around 10 minutes and a timed-out poll strands the user with no
   verdict). Each poll call checks for at most ~2 minutes, then RETURNS, and
   you call it again — up to 4 bursts (~8 minutes total). `pollUrl` may carry
   an internal host, so rebuild it from `$LEARN_UPSTREAM_URL` and the jobId:

   ```bash
   for i in $(seq 1 8); do
     R=$(curl -s "$LEARN_UPSTREAM_URL/learn/api/generate-classroom/$JOB_ID")
     echo "$R" | grep -qE '"status":"(succeeded|failed)"' && break
     sleep 14
   done
   echo "$R"
   ```

   Between bursts, relay `progress`/`message` in one short line. **If it is
   still running after ~8 minutes, do NOT keep polling and do NOT end with a
   question**: the job keeps running server-side and the finished course
   appears under Learn's Recent list on its own. Give the user the Learn
   link (step 5's `$BASE/assistant/learn`) with a note that the course is
   still generating and will appear there in a few minutes. That is a
   COMPLETE answer.

5. **Deliver the link.** On success the result carries the classroom URL —
   take its **last path segment** as the classroom id. Build the user-facing
   link from the instance's public origin:

   ```bash
   BASE=$(assistant config get ingress.publicBaseUrl | tr -d '"')
   echo "$BASE/assistant/learn?p=/classroom/$CLASSROOM_ID"
   ```

   Reply with one short line about what the course covers (scene count if you
   have it) and that link as a markdown link titled with the course topic —
   it opens the classroom inside Cue's Learn surface, voice and all. Do not
   paste the internal (`.internal`) URL.

6. **On failure**, relay the job's `error` plainly and suggest retrying or
   narrowing the topic. Never leave the user with a spinner and no verdict.

## Notes

- One course per request — confirm before batch-generating several.
- The classroom keeps living under **Learn** in the sidebar; mention that the
  user can revisit and continue it there.
- Generation cost lands on the workspace ledger automatically (actor "learn");
  no need to track or mention cost unless asked.

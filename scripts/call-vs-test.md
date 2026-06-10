# Call transcript vs test.txt comparison

**Source call:** `phone-d952f7a1dfe54a3212026e2580be0ebd` (2026-06-07, 214s, resolved, no dispatch)

Note: The newest call in the DB (2026-06-09) completed but saved **zero messages** — likely hung up before speech was processed or a webhook issue.

## Old test.txt (technician-style)

| Pattern | Example |
|---------|---------|
| Knows exact panel | "Notifier NFS2-3030 at my office" |
| Knows error code | "error code star 2, low battery" |
| Already did tech steps | "checked the terminals, they're tight" |
| Follows instructions precisely | "unplugged the modem for 30 seconds" |
| Clean dispatch close | "schedule a technician for tomorrow morning" |

**Problem:** ~95% of real callers don't sound like this. Great for golden-path QA, bad for training/tuning the agent.

## Real customer call (what actually happened)

| Pattern | Example |
|---------|---------|
| Hesitation / fillers | "hi uh", "uh it's uh", "okay I'll" |
| Uncertain panel ID | "BFC Neo" (ASR garble of brand name) |
| Symptom not code | "the Double light is on" (trouble light) |
| Partial answers | "okay", "yeah it's" |
| User-initiated fix attempt | entered code → silenced beep, trouble stayed |
| Corrects the agent | "it's not a detector it's connected to fire panel" |
| No dispatch | "I'll call back" after checking wires |

**Agent issues exposed:** Asked for brand/model first; assumed detector trouble; caller had to correct diagnosis.

## New test.txt (updated)

Blends real speech patterns with a complete test arc:

- Keeps vagueness (unknown brand, no error code, trouble light only)
- Keeps ASR-style uncertainty ("BFC Neo", fillers)
- Keeps code-silence / trouble-stays behavior from real call
- Adds dispatch ask at end so the script still exercises full triage → dispatch flow

## Regenerate from DB

```bash
npm run export-call          # customer lines only
npm run export-call -- --full   # customer + agent
npm run export-call -- --json   # full JSON dump
```

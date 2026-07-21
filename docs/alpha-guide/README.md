# Alpha tester guide

`comparative-alpha-tester-guide.pdf` is the onboarding guide sent to alpha
testers (8 pages: login, first-run, chat, artifacts, tools, feedback). The
built PDF is no longer committed — it is a generated artifact that bakes in
deployment hostnames and app screenshots. Build it locally and distribute it
from there.

Regenerate after UI changes: `capture-screenshots.ts` drives the app and
captures the screenshots; `build_pdf.py` lays out the PDF (set `LINKS` to your
own deployment hostname first). Screenshots must be taken against a fresh
account so no real data appears in the guide.

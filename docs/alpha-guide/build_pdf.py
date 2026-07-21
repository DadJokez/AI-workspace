from __future__ import annotations

from pathlib import Path
from textwrap import wrap

from PIL import Image
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output/pdf/comparative-alpha-tester-guide.pdf"
SHOT_DIR = ROOT / "tmp/pdfs/alpha-guide/screenshots"

LINKS = {
    "home": "https://app.comparative.example",
    "chat": "https://app.comparative.example/chat",
    "login": "https://app.comparative.example/login",
    "skills": "https://app.comparative.example/skills",
    "apps": "https://app.comparative.example/apps",
}

PAGE_W, PAGE_H = landscape(letter)
M = 36
INK = HexColor("#18181b")
MUTED = HexColor("#62666f")
SUBTLE = HexColor("#f5f5f2")
HAIRLINE = HexColor("#ddddda")
BLUE = HexColor("#1769e0")
BLUE_DARK = HexColor("#0f4fb3")
GREEN = HexColor("#127a51")
AMBER = HexColor("#8a5a00")


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=(PAGE_W, PAGE_H))
    page = 1
    cover(c, page)
    page = next_page(c, page)
    login_page(c, page)
    page = next_page(c, page)
    onboarding_page(c, page)
    page = next_page(c, page)
    chat_page(c, page)
    page = next_page(c, page)
    artifact_page(c, page)
    page = next_page(c, page)
    tools_page(c, page)
    page = next_page(c, page)
    artifacts_feedback_page(c, page)
    page = next_page(c, page)
    checklist_page(c, page)
    c.save()
    print(OUT)


def next_page(c: canvas.Canvas, page: int) -> int:
    footer(c, page)
    c.showPage()
    return page + 1


def footer(c: canvas.Canvas, page: int) -> None:
    c.setStrokeColor(HAIRLINE)
    c.setLineWidth(0.5)
    c.line(M, 32, PAGE_W - M, 32)
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8.5)
    c.drawString(M, 19, "Comparative alpha tester guide")
    c.drawRightString(PAGE_W - M, 19, f"Page {page}")
    c.setFillColor(BLUE_DARK)
    c.drawString(M + 135, 19, LINKS["chat"])
    c.linkURL(LINKS["chat"], (M + 135, 16, M + 305, 28), relative=0)


def title(c: canvas.Canvas, text: str, kicker: str | None = None) -> None:
    if kicker:
        c.setFillColor(MUTED)
        c.setFont("Helvetica-Bold", 8.5)
        c.drawString(M, PAGE_H - 45, kicker.upper())
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 24)
    c.drawString(M, PAGE_H - 76, text)


def cover(c: canvas.Canvas, page: int) -> None:
    c.setFillColor(HexColor("#fbfbf8"))
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 36)
    c.drawString(M, PAGE_H - 94, "Comparative")
    c.setFont("Helvetica-Bold", 22)
    c.drawString(M, PAGE_H - 127, "Alpha Tester Guide")
    c.setFont("Helvetica", 12)
    c.setFillColor(MUTED)
    c.drawString(M, PAGE_H - 153, "Screenshots, links, and first-run walkthrough")
    c.drawString(M, PAGE_H - 173, "Prepared June 17, 2026")

    y = PAGE_H - 230
    y = paragraph(
        c,
        "Comparative is the internal AI workspace for chat, file work, reusable Skills, generated Apps, and alpha feedback.",
        M,
        y,
        312,
        size=12,
        leading=17,
    )
    y -= 20
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(INK)
    c.drawString(M, y, "Quick links")
    y -= 31
    draw_button(c, "Open Comparative", LINKS["chat"], M, y, 168, 28, BLUE)
    draw_button(c, "Login", LINKS["login"], M + 184, y, 104, 28, INK)
    y -= 44
    draw_button(c, "Skills", LINKS["skills"], M, y, 104, 26, GREEN)
    draw_button(c, "Apps", LINKS["apps"], M + 120, y, 104, 26, AMBER)

    y -= 58
    card(c, M, y - 115, 322, 115)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(M + 14, y - 24, "Tester access")
    c.setFont("Helvetica", 9.5)
    c.setFillColor(MUTED)
    lines = [
        "Access is invite-only.",
        "Use the invite link from an admin or open the login link.",
        "Sign in with the GitHub account tied to the invited email.",
        "Use Feedback in the sidebar when something breaks or feels unclear.",
    ]
    text_y = y - 45
    for line in lines:
        c.drawString(M + 18, text_y, f"- {line}")
        text_y -= 15

    draw_image_box(
        c,
        SHOT_DIR / "05-chat-home.png",
        395,
        PAGE_H - 88,
        350,
        322,
        "Main chat workspace",
    )
    footer(c, page)


def login_page(c: canvas.Canvas, page: int) -> None:
    title(c, "Log In", "Step 1")
    y = PAGE_H - 122
    bullets = [
        "Open the alpha URL or your individual invite link.",
        "Click Sign in with GitHub.",
        "Approve the GitHub sign-in prompt.",
        "Use the GitHub account whose email was invited. If you see AccessDenied, ask an admin to invite that exact email.",
        "After sign-in, Comparative opens the chat workspace at /chat.",
    ]
    y = bullets_block(c, bullets, M, y, 310)
    y -= 18
    link_row(c, "Login link", LINKS["login"], M, y)
    y -= 24
    link_row(c, "Main workspace", LINKS["chat"], M, y)
    y -= 35
    note(
        c,
        M,
        y - 72,
        310,
        72,
        "Invite links are per tester and look like /invite/<token>. Do not forward another tester's invite link.",
    )
    draw_image_box(
        c,
        SHOT_DIR / "01-login.png",
        388,
        PAGE_H - 92,
        358,
        362,
        "Invite-only GitHub login",
    )


def onboarding_page(c: canvas.Canvas, page: int) -> None:
    title(c, "First-Run Setup", "Step 2")
    y = PAGE_H - 120
    bullets = [
        "Name your assistant. The name appears in chat responses and can be changed later.",
        "Connect GitHub if you want Comparative to work with repositories, issues, and pull requests.",
        "You can skip tool connection during setup and return to Tools later.",
        "The setup asks about your role, common tools, and the first task you would hand off. This helps seed better defaults.",
    ]
    y = bullets_block(c, bullets, M, y, 305)
    y -= 14
    note(
        c,
        M,
        y - 66,
        305,
        66,
        "Every provider connection is approved by the signed-in user. Sharing a Skill or App does not share the owner's credentials.",
    )
    draw_image_box(
        c,
        SHOT_DIR / "02-first-run-name.png",
        382,
        PAGE_H - 88,
        360,
        220,
        "Name your assistant",
    )
    draw_image_box(
        c,
        SHOT_DIR / "03-first-run-tools.png",
        382,
        PAGE_H - 338,
        360,
        220,
        "Connect tools or skip for now",
    )


def chat_page(c: canvas.Canvas, page: int) -> None:
    title(c, "Use Chat For Real Work", "Step 3")
    y = PAGE_H - 120
    bullets = [
        "Type a request in the bottom composer.",
        "Attach PDFs, docs, spreadsheets, decks, screenshots, notes, HTML, or data files.",
        "Use the suggested prompts if you want a fast first test.",
        "Type / to find Skills available to your account.",
        "Use the sidebar to revisit recent chats, open Tools, Artifacts, Skills, Apps, Settings, or Feedback.",
    ]
    bullets_block(c, bullets, M, y, 310)
    draw_image_box(
        c,
        SHOT_DIR / "05-chat-home.png",
        388,
        PAGE_H - 92,
        358,
        362,
        "New chat with navigation and composer",
    )


def artifact_page(c: canvas.Canvas, page: int) -> None:
    title(c, "Artifacts And Apps", "Step 4")
    y = PAGE_H - 120
    bullets = [
        "When Comparative creates a file or small HTML tool, it appears as an artifact in the chat.",
        "Preview and download artifacts from the chat or the Artifacts panel.",
        "If an artifact looks reusable, use Deploy app to turn it into a signed-in workspace app.",
        "Open Apps to manage deployed tools and share them with teammates.",
    ]
    y = bullets_block(c, bullets, M, y, 310)
    y -= 16
    link_row(c, "Apps link", LINKS["apps"], M, y)
    y -= 32
    link_row(c, "Artifacts live inside chat", LINKS["chat"], M, y)
    draw_image_box(
        c,
        SHOT_DIR / "06-chat-artifact-recommendation.png",
        388,
        PAGE_H - 92,
        358,
        362,
        "Artifact with deploy recommendation",
    )


def tools_page(c: canvas.Canvas, page: int) -> None:
    title(c, "Connect Tools Deliberately", "Step 5")
    y = PAGE_H - 120
    bullets = [
        "Open Tools from the sidebar.",
        "GitHub is the live alpha integration.",
        "Microsoft 365, Salesforce, ServiceNow, SAP, Workfront, Databricks, Notion, and Google Calendar are visible as planned integrations.",
        "A connection controls what the assistant may access for your account.",
        "Disconnect or avoid connecting anything you do not want used in testing.",
    ]
    bullets_block(c, bullets, M, y, 310)
    draw_image_box(
        c,
        SHOT_DIR / "07-tools.png",
        388,
        PAGE_H - 92,
        358,
        362,
        "Tools catalog",
    )


def artifacts_feedback_page(c: canvas.Canvas, page: int) -> None:
    title(c, "Find Work And Send Feedback", "Step 6")
    y = PAGE_H - 120
    bullets = [
        "Artifacts stores generated files and versions so you can reopen, preview, or download them later.",
        "Feedback sends a structured report to the admin inbox.",
        "Leave Include current chat context checked when the problem happened in a chat.",
        "Attach a screenshot when the issue is visual or hard to describe.",
    ]
    y = bullets_block(c, bullets, M, y, 315)
    y -= 14
    note(
        c,
        M,
        y - 80,
        315,
        80,
        "Good feedback includes what you tried, what happened, what you expected, and whether the issue blocks your test.",
    )
    draw_image_box(
        c,
        SHOT_DIR / "08-artifacts.png",
        380,
        PAGE_H - 88,
        365,
        205,
        "Artifacts list",
    )
    draw_image_box(
        c,
        SHOT_DIR / "09-feedback.png",
        380,
        PAGE_H - 318,
        365,
        235,
        "Feedback report modal",
    )


def checklist_page(c: canvas.Canvas, page: int) -> None:
    title(c, "Alpha Test Checklist", "What to try")
    y = PAGE_H - 118
    left = [
        "Log in with your invited GitHub account.",
        "Complete or skip first-run setup.",
        "Ask one real work question.",
        "Upload one safe test file and ask for a summary or transformation.",
        "Try one repeated workflow as a Skill from /skills.",
        "Ask for a small dashboard or page, then inspect the artifact.",
        "Open Tools and confirm what is connected.",
        "Send Feedback for one issue, confusing answer, or missing feature.",
    ]
    bullets_block(c, left, M, y, 340)

    x = 430
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(x, y, "Useful links")
    y2 = y - 28
    for label, key in [
        ("Open Comparative", "chat"),
        ("Login", "login"),
        ("Skills", "skills"),
        ("Apps", "apps"),
    ]:
        draw_button(c, label, LINKS[key], x, y2, 210, 28, BLUE if key == "chat" else INK)
        y2 -= 44

    y2 -= 8
    note(
        c,
        x,
        y2 - 110,
        300,
        110,
        "Please avoid pasting passwords, API keys, OAuth codes, or other credentials into chat. Use Feedback rather than screenshots in email when you need to report a product issue.",
    )


def draw_button(
    c: canvas.Canvas,
    label: str,
    url: str,
    x: float,
    y: float,
    w: float,
    h: float,
    color,
) -> None:
    c.setFillColor(color)
    c.roundRect(x, y, w, h, 6, fill=1, stroke=0)
    c.setFillColor(HexColor("#ffffff"))
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(x + w / 2, y + h / 2 - 3, label)
    c.linkURL(url, (x, y, x + w, y + h), relative=0)


def card(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    c.setFillColor(HexColor("#ffffff"))
    c.setStrokeColor(HAIRLINE)
    c.roundRect(x, y, w, h, 8, fill=1, stroke=1)


def note(c: canvas.Canvas, x: float, y: float, w: float, h: float, text: str) -> None:
    c.setFillColor(SUBTLE)
    c.setStrokeColor(HAIRLINE)
    c.roundRect(x, y, w, h, 7, fill=1, stroke=1)
    paragraph(c, text, x + 12, y + h - 20, w - 24, size=9.5, leading=13)


def link_row(c: canvas.Canvas, label: str, url: str, x: float, y: float) -> None:
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 9.5)
    c.drawString(x, y, f"{label}:")
    offset = stringWidth(f"{label}:", "Helvetica-Bold", 9.5) + 12
    c.setFillColor(BLUE_DARK)
    c.setFont("Helvetica", 9.5)
    c.drawString(x + offset, y, url)
    c.linkURL(url, (x + offset, y - 2, x + offset + 250, y + 12), relative=0)


def bullets_block(
    c: canvas.Canvas,
    bullets: list[str],
    x: float,
    y: float,
    width: float,
    size: float = 10.5,
    leading: float = 15,
) -> float:
    c.setFillColor(INK)
    for bullet in bullets:
        wrapped = wrap(bullet, width=max(32, int(width / (size * 0.47))))
        for i, line in enumerate(wrapped):
            prefix = "- " if i == 0 else "  "
            c.setFont("Helvetica", size)
            c.drawString(x, y, prefix + line)
            y -= leading
        y -= 4
    return y


def paragraph(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    size: float = 10,
    leading: float = 14,
) -> float:
    c.setFont("Helvetica", size)
    c.setFillColor(MUTED)
    chars = max(28, int(width / (size * 0.46)))
    for line in wrap(text, width=chars):
        c.drawString(x, y, line)
        y -= leading
    return y


def draw_image_box(
    c: canvas.Canvas,
    image_path: Path,
    x: float,
    y_top: float,
    w: float,
    h: float,
    caption: str,
) -> None:
    if not image_path.exists():
        raise FileNotFoundError(image_path)
    c.setFillColor(HexColor("#ffffff"))
    c.setStrokeColor(HAIRLINE)
    c.roundRect(x, y_top - h, w, h, 8, fill=1, stroke=1)

    caption_h = 20
    pad = 8
    with Image.open(image_path) as im:
        img_w, img_h = im.size
    max_w = w - pad * 2
    max_h = h - caption_h - pad * 2
    scale = min(max_w / img_w, max_h / img_h)
    draw_w = img_w * scale
    draw_h = img_h * scale
    draw_x = x + (w - draw_w) / 2
    draw_y = y_top - pad - draw_h
    c.drawImage(
        ImageReader(str(image_path)),
        draw_x,
        draw_y,
        width=draw_w,
        height=draw_h,
        preserveAspectRatio=True,
        mask="auto",
    )
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 8.5)
    c.drawString(x + pad, y_top - h + 8, caption)


if __name__ == "__main__":
    main()

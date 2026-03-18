import os
import re
import json
import anthropic
import requests
from functools import wraps
from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
from services.quote_api import create_quote

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-secret-key")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
CORS(app)

FRONT_API_BASE = "https://api2.frontapp.com"
FRONT_API_TOKEN = os.getenv("FRONT_API_TOKEN", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin")

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
CONFIG_FILE = os.path.join(DATA_DIR, "inbox_configs.json")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {"txt", "pdf", "md", "csv", "json", "docx"}

DEFAULT_PROMPT = """Tu es un assistant professionnel specialise dans la redaction de reponses emails.
On te fournit le contexte d'une conversation email (messages precedents).
Tu dois proposer un brouillon de reponse professionnel, clair et adapte au ton de la conversation.
Reponds en francais sauf si la conversation est dans une autre langue.
Sois concis et professionnel."""


def load_all_configs():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_all_configs(configs):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(configs, f, ensure_ascii=False, indent=2)


def get_inbox_config(inbox_id):
    configs = load_all_configs()
    return configs.get(inbox_id, {"instructions": "", "files": {}})


def set_inbox_config(inbox_id, config):
    configs = load_all_configs()
    configs[inbox_id] = config
    save_all_configs(configs)


def front_headers():
    return {
        "Authorization": f"Bearer {FRONT_API_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def extract_file_text(filepath):
    ext = filepath.rsplit(".", 1)[1].lower()
    if ext in ("txt", "md", "csv", "json"):
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    elif ext == "pdf":
        try:
            import PyPDF2
            text = ""
            with open(filepath, "rb") as f:
                reader = PyPDF2.PdfReader(f)
                for page in reader.pages:
                    text += page.extract_text() or ""
            return text
        except ImportError:
            return "[PDF support requires PyPDF2: pip install PyPDF2]"
    elif ext == "docx":
        try:
            import docx
            doc = docx.Document(filepath)
            return "\n".join(p.text for p in doc.paragraphs)
        except ImportError:
            return "[DOCX support requires python-docx: pip install python-docx]"
    return ""


def inbox_upload_dir(inbox_id):
    safe_id = secure_filename(inbox_id)
    d = os.path.join(UPLOAD_DIR, safe_id)
    os.makedirs(d, exist_ok=True)
    return d


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("X-Admin-Password", "")
        if auth != ADMIN_PASSWORD:
            return jsonify({"error": "Acces refuse. Mot de passe admin incorrect."}), 403
        return f(*args, **kwargs)
    return decorated


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json()
    if data.get("password") == ADMIN_PASSWORD:
        return jsonify({"status": "ok"})
    return jsonify({"error": "Mot de passe incorrect"}), 403


@app.route("/api/config/<inbox_id>", methods=["GET"])
@require_admin
def get_config(inbox_id):
    config = get_inbox_config(inbox_id)
    return jsonify({
        "instructions": config.get("instructions", ""),
        "files": list(config.get("files", {}).keys()),
    })


@app.route("/api/config/<inbox_id>/instructions", methods=["POST"])
@require_admin
def save_instructions(inbox_id):
    data = request.get_json()
    config = get_inbox_config(inbox_id)
    config["instructions"] = data.get("instructions", "")
    set_inbox_config(inbox_id, config)
    return jsonify({"status": "ok"})


@app.route("/api/config/<inbox_id>/upload", methods=["POST"])
@require_admin
def upload_file(inbox_id):
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if f.filename == "":
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(f.filename):
        return jsonify({"error": f"Type non supporte. Types acceptes: {', '.join(ALLOWED_EXTENSIONS)}"}), 400
    filename = secure_filename(f.filename)
    upload_path = inbox_upload_dir(inbox_id)
    filepath = os.path.join(upload_path, filename)
    f.save(filepath)
    content = extract_file_text(filepath)
    config = get_inbox_config(inbox_id)
    if "files" not in config:
        config["files"] = {}
    config["files"][filename] = content
    set_inbox_config(inbox_id, config)
    return jsonify({"status": "ok", "filename": filename})


@app.route("/api/config/<inbox_id>/files/<filename>", methods=["DELETE"])
@require_admin
def delete_file(inbox_id, filename):
    filename = secure_filename(filename)
    config = get_inbox_config(inbox_id)
    if "files" in config:
        config["files"].pop(filename, None)
    set_inbox_config(inbox_id, config)
    filepath = os.path.join(inbox_upload_dir(inbox_id), filename)
    if os.path.exists(filepath):
        os.remove(filepath)
    return jsonify({"status": "ok"})


@app.route("/api/inboxes")
def get_inboxes():
    resp = requests.get(f"{FRONT_API_BASE}/inboxes", headers=front_headers())
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), resp.status_code
    return jsonify(resp.json())


@app.route("/api/inboxes/<inbox_id>/conversations")
def get_inbox_conversations(inbox_id):
    page_token = request.args.get("page_token", "")
    url = f"{FRONT_API_BASE}/inboxes/{inbox_id}/conversations"
    params = {}
    if page_token:
        params["page_token"] = page_token
    resp = requests.get(url, headers=front_headers(), params=params)
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), resp.status_code
    data = resp.json()
    if "_results" in data:
        data["_results"] = [
            c for c in data["_results"]
            if c.get("status") not in ("archived", "trashed", "deleted")
        ]
    return jsonify(data)


@app.route("/api/conversations/<path:conversation_id>/summary")
def get_conversation_summary(conversation_id):
    resp = requests.get(
        f"{FRONT_API_BASE}/conversations/{conversation_id}/messages",
        headers=front_headers(),
    )
    if resp.status_code != 200:
        return jsonify({"summary": ""})
    messages = resp.json().get("_results", [])
    if not messages:
        return jsonify({"summary": ""})
    text = ""
    for m in messages[:5]:
        author = ""
        if m.get("author"):
            author = (m["author"].get("first_name", "") + " " + m["author"].get("last_name", "")).strip()
        raw_body = m.get("body", "")
        body = re.sub(r"<(style|script)[^>]*>.*?</\1>", "", raw_body, flags=re.DOTALL | re.IGNORECASE)
        body = re.sub(r"<[^>]+>", " ", body)
        body = re.sub(r"\s+", " ", body).strip()[:300]
        text += f"{author}: {body}\n"
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        result = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=120,
            messages=[{"role": "user", "content": (
                "Analyse cette conversation email et reponds en JSON (sans backticks, juste le JSON) :\n"
                '{"summary":"resume en 1 phrase courte max 15 mots en francais",'
                '"quote_ready":true/false,'
                '"quote_ready_reason":"raison courte si false"}\n\n'
                "quote_ready = true UNIQUEMENT si TOUTES ces conditions sont reunies :\n"
                "1. Le client demande un devis ou un chiffrage\n"
                "2. On lui a fait une proposition chiffree (prix, dimensions)\n"
                "3. Le client a CONFIRME/VALIDE la proposition (accord explicite)\n"
                "4. On a ses coordonnees (nom + email minimum)\n"
                "Si une de ces conditions manque, quote_ready = false.\n\n"
                f"{text}"
            )}],
        )
        raw = result.content[0].text.strip()
        raw = re.sub(r"^```json?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw).strip()
        try:
            parsed = json.loads(raw)
            summary = parsed.get("summary", "")
            quote_ready = parsed.get("quote_ready", False)
            quote_ready_reason = parsed.get("quote_ready_reason", "")
        except (json.JSONDecodeError, ValueError):
            summary = raw
            quote_ready = False
            quote_ready_reason = ""
    except Exception:
        summary = ""
        quote_ready = False
        quote_ready_reason = ""
    return jsonify({
        "summary": summary,
        "quote_ready": quote_ready,
        "quote_ready_reason": quote_ready_reason,
    })


@app.route("/api/conversations/<path:conversation_id>/drafts")
def get_conversation_drafts(conversation_id):
    resp = requests.get(
        f"{FRONT_API_BASE}/conversations/{conversation_id}/drafts",
        headers=front_headers(),
    )
    if resp.status_code != 200:
        return jsonify({"has_draft": False})
    data = resp.json()
    drafts = data.get("_results", [])
    # Only count shared drafts (private ones are API artifacts)
    shared_drafts = [d for d in drafts if d.get("draft_mode") == "shared"]
    return jsonify({"has_draft": len(shared_drafts) > 0})


@app.route("/api/conversations/<path:conversation_id>/messages")
def get_messages(conversation_id):
    resp = requests.get(
        f"{FRONT_API_BASE}/conversations/{conversation_id}/messages",
        headers=front_headers(),
    )
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), resp.status_code
    return jsonify(resp.json())


@app.route("/api/chat", methods=["POST"])
def chat_with_claude():
    data = request.get_json()
    inbox_id = data.get("inbox_id", "")
    messages_context = data.get("messages_context", "")
    chat_history = data.get("chat_history", [])
    user_message = data.get("user_message", "")
    if not user_message and not messages_context:
        return jsonify({"error": "No message provided"}), 400
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    config = get_inbox_config(inbox_id) if inbox_id else {}
    instructions = config.get("instructions", "")
    files = config.get("files", {})
    system = instructions if instructions else DEFAULT_PROMPT
    if files:
        system += "\n\n--- DOCUMENTS DE REFERENCE ---"
        for fname, fcontent in files.items():
            system += f"\n\n[{fname}]:\n{fcontent}"
    if messages_context:
        system += f"\n\n--- CONVERSATION EMAIL ---\n{messages_context}"
    system += "\n\nIMPORTANT: Tu rediges uniquement des BROUILLONS. Ne propose jamais d'envoyer directement."
    api_messages = []
    for msg in chat_history:
        api_messages.append({"role": msg["role"], "content": msg["content"]})
    api_messages.append({"role": "user", "content": user_message})
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        system=system,
        messages=api_messages,
    )
    assistant_text = response.content[0].text
    return jsonify({"response": assistant_text})


def _get_channel_and_author(conversation_id):
    """Find SMTP channel and admin author for a conversation."""
    channel_id = None
    author_id = None
    conv_resp = requests.get(
        f"{FRONT_API_BASE}/conversations/{conversation_id}",
        headers=front_headers(),
    )
    if conv_resp.status_code == 200:
        conv_data = conv_resp.json()
        inbox_links = conv_data.get("_links", {}).get("related", {})
        inboxes_url = inbox_links.get("inboxes")
        if inboxes_url:
            inboxes_resp = requests.get(inboxes_url, headers=front_headers())
            if inboxes_resp.status_code == 200:
                for inbox in inboxes_resp.json().get("_results", []):
                    ch_resp = requests.get(
                        f"{FRONT_API_BASE}/inboxes/{inbox['id']}/channels",
                        headers=front_headers(),
                    )
                    if ch_resp.status_code == 200:
                        for ch in ch_resp.json().get("_results", []):
                            if ch.get("type") == "smtp":
                                channel_id = ch["id"]
                                break
                    if channel_id:
                        break
        teammates_resp = requests.get(
            f"{FRONT_API_BASE}/teammates", headers=front_headers()
        )
        if teammates_resp.status_code == 200:
            for t in teammates_resp.json().get("_results", []):
                if t.get("is_admin") and t.get("type") != "api":
                    author_id = t["id"]
                    break
    return channel_id, author_id


@app.route("/api/drafts", methods=["POST"])
def create_draft():
    data = request.get_json()
    conversation_id = data.get("conversation_id")
    body = data.get("body", "")
    if not conversation_id or not body:
        return jsonify({"error": "conversation_id and body are required"}), 400

    channel_id, author_id = _get_channel_and_author(conversation_id)

    # Check if a shared draft already exists — if so, edit it instead
    existing_resp = requests.get(
        f"{FRONT_API_BASE}/conversations/{conversation_id}/drafts",
        headers=front_headers(),
    )
    existing_draft = None
    if existing_resp.status_code == 200:
        for d in existing_resp.json().get("_results", []):
            if d.get("draft_mode") == "shared":
                existing_draft = d
                break

    if existing_draft:
        # Edit existing draft
        draft_id = existing_draft["id"]
        version = existing_draft.get("version", "")
        edit_payload = {"body": body, "version": version}
        if channel_id:
            edit_payload["channel_id"] = channel_id
        resp = requests.patch(
            f"{FRONT_API_BASE}/drafts/{draft_id}",
            headers=front_headers(),
            json=edit_payload,
        )
    else:
        # Create new shared draft
        payload = {"body": body, "mode": "shared"}
        if channel_id:
            payload["channel_id"] = channel_id
        if author_id:
            payload["author_id"] = author_id
        resp = requests.post(
            f"{FRONT_API_BASE}/conversations/{conversation_id}/drafts",
            headers=front_headers(),
            json=payload,
        )

    if resp.status_code not in (200, 201, 202):
        return jsonify({"error": resp.text}), resp.status_code
    try:
        return jsonify(resp.json())
    except Exception:
        return jsonify({"status": "draft_created"})


@app.route("/api/channels")
def get_channels():
    resp = requests.get(f"{FRONT_API_BASE}/channels", headers=front_headers())
    if resp.status_code != 200:
        return jsonify({"error": resp.text}), resp.status_code
    return jsonify(resp.json())


@app.route("/api/create-quote", methods=["POST"])
def api_create_quote():
    data = request.get_json()
    conversation_id = data.get("conversationId")

    # 1. Create quote in Pennylane
    result = create_quote(
        customer=data.get("customer"),
        customer_id=data.get("customerId"),
        lines=data.get("lines", []),
        subject=data.get("subject"),
        deadline=data.get("deadline"),
        free_text=data.get("freeText"),
        special_mention=data.get("specialMention"),
        external_ref=data.get("externalRef"),
        inbox_name=data.get("inboxName", ""),
    )
    if result.get("error"):
        return jsonify(result), 400

    return jsonify(result)


@app.route("/api/draft-with-quote", methods=["POST"])
def draft_with_quote():
    """Create a Front draft with PDF quote attachment."""
    data = request.get_json()
    conversation_id = data.get("conversation_id")
    body = data.get("body", "")
    pdf_url = data.get("pdf_url", "")
    quote_number = data.get("quote_number", "")

    if not conversation_id or not body:
        return jsonify({"error": "conversation_id and body required"}), 400

    channel_id, author_id = _get_channel_and_author(conversation_id)

    # Download PDF
    pdf_content = None
    pdf_filename = f"Devis-{quote_number}.pdf" if quote_number else "devis.pdf"
    if pdf_url:
        try:
            pdf_resp = requests.get(pdf_url, timeout=20)
            if pdf_resp.status_code == 200:
                pdf_content = pdf_resp.content
        except Exception:
            pass

    # Delete existing shared drafts
    existing_resp = requests.get(
        f"{FRONT_API_BASE}/conversations/{conversation_id}/drafts",
        headers=front_headers(),
    )
    if existing_resp.status_code == 200:
        for d in existing_resp.json().get("_results", []):
            if d.get("draft_mode") == "shared":
                try:
                    requests.delete(
                        f"{FRONT_API_BASE}/drafts/{d['id']}",
                        headers=front_headers(),
                        json={"version": d.get("version", "")},
                    )
                except Exception:
                    pass

    # Create draft
    draft_data = {"body": body, "mode": "shared"}
    if channel_id:
        draft_data["channel_id"] = channel_id
    if author_id:
        draft_data["author_id"] = author_id

    if pdf_content:
        # Multipart with attachment
        draft_files = {
            "attachments[]": (pdf_filename, pdf_content, "application/pdf"),
        }
        resp = requests.post(
            f"{FRONT_API_BASE}/conversations/{conversation_id}/drafts",
            headers={"Authorization": f"Bearer {FRONT_API_TOKEN}"},
            data=draft_data,
            files=draft_files,
        )
    else:
        # JSON without attachment
        resp = requests.post(
            f"{FRONT_API_BASE}/conversations/{conversation_id}/drafts",
            headers=front_headers(),
            json=draft_data,
        )

    if resp.status_code not in (200, 201, 202):
        return jsonify({"error": resp.text}), resp.status_code
    try:
        return jsonify(resp.json())
    except Exception:
        return jsonify({"status": "draft_created"})


if __name__ == "__main__":
    app.run(debug=True, port=5001)

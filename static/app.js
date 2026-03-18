let currentInbox = null;
let currentConversation = null;
let conversationMessages = [];
let chatHistory = [];
let messagesContext = "";
let adminPassword = "";
let chatMode = false;
let draftedConversations = new Set();
let currentQuote = null; // stores {pdfUrl, quoteNumber} after quote creation

function goToStep(step) {
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.getElementById("step" + step).classList.add("active");
    if (step === 0) { currentInbox = null; loadInboxes(); }
    if (step === 1 && currentInbox) { loadConversations(); }
    if (step === 2) { resetChatMode(); }
}

function resetChatMode() {
    chatMode = false;
    document.getElementById("chat-section").style.display = "none";
    document.getElementById("generate-bar").style.display = "";
    document.getElementById("email-viewer").classList.remove("compact");
}

function showChatMode() {
    chatMode = true;
    document.getElementById("chat-section").style.display = "flex";
    document.getElementById("generate-bar").style.display = "none";
    document.getElementById("email-viewer").classList.add("compact");
    document.getElementById("user-input").focus();
    if (chatHistory.length === 0) {
        addChatMessage("assistant", "J'ai lu la conversation. Dites-moi comment vous souhaitez repondre et je redige le brouillon pour vous.", false);
    }
}

function backToChat() {
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.getElementById("step2").classList.add("active");
    showChatMode();
}

async function loadInboxes() {
    const grid = document.getElementById("inboxes-grid");
    grid.innerHTML = '<p class="placeholder"><span class="loading"></span> Chargement des boites...</p>';
    try {
        const resp = await fetch("/api/inboxes");
        const data = await resp.json();
        if (data.error) { grid.innerHTML = '<p class="placeholder">Erreur : ' + escapeHtml(data.error) + '</p>'; return; }
        const BOUTIQUES = ["le filet", "le voile", "tarnnetz", "ma toile coco", "het", "red", "rete", "mon ombrage"];
        const inboxes = (data._results || []).filter(inbox => BOUTIQUES.some(b => inbox.name.toLowerCase().includes(b)));
        if (inboxes.length === 0) { grid.innerHTML = '<p class="placeholder">Aucune boite trouvee.</p>'; return; }
        grid.innerHTML = "";
        inboxes.forEach(inbox => {
            const card = document.createElement("div");
            card.className = "inbox-card";
            card.onclick = () => selectInbox(inbox);
            const initials = inbox.name.split(/\s+/).map(w => w[0]).join("").substring(0, 2).toUpperCase();
            card.innerHTML = '<div class="inbox-icon">' + escapeHtml(initials) + '</div><div class="inbox-name">' + escapeHtml(inbox.name) + '</div>';
            grid.appendChild(card);
        });
    } catch (e) {
        grid.innerHTML = '<p class="placeholder">Erreur de connexion. Verifiez votre token Front.</p>';
        console.error(e);
    }
}

function selectInbox(inbox) {
    currentInbox = inbox;
    document.getElementById("inbox-title").textContent = inbox.name;
    goToStep(1);
}

async function loadConversations() {
    const list = document.getElementById("conversations-list");
    list.innerHTML = '<p class="placeholder"><span class="loading"></span> Chargement...</p>';
    try {
        const resp = await fetch("/api/inboxes/" + encodeURIComponent(currentInbox.id) + "/conversations");
        const data = await resp.json();
        if (data.error) { list.innerHTML = '<p class="placeholder">Erreur : ' + escapeHtml(data.error) + '</p>'; return; }
        const conversations = data._results || [];
        if (conversations.length === 0) { list.innerHTML = '<p class="placeholder">Aucune conversation non archivee.</p>'; return; }
        list.innerHTML = "";
        conversations.forEach(conv => {
            const item = document.createElement("div");
            item.className = "conversation-item";
            item.onclick = () => selectConversation(conv);
            const subject = conv.subject || "(sans objet)";
            const status = conv.status || "";
            const badgeClass = status === "unassigned" ? "unassigned" : "assigned";
            item.innerHTML = '<div><div class="subject">' + escapeHtml(subject) + ' <span class="status-badge ' + badgeClass + '">' + escapeHtml(status) + '</span><span class="draft-badge" data-conv="' + conv.id + '" style="display:none">brouillon</span><span class="quote-badge" data-conv="' + conv.id + '" style="display:none">devis PDF a faire</span></div><div class="preview summary-loading">...</div><div class="meta">' + (conv.last_message ? formatDate(conv.last_message.created_at) : "") + '</div></div>';
            list.appendChild(item);
            fetchSummary(conv.id, item.querySelector(".preview"), item.querySelector('.quote-badge'));
            checkDraft(conv.id, item.querySelector('.draft-badge'));
        });
    } catch (e) {
        list.innerHTML = '<p class="placeholder">Erreur de connexion.</p>';
        console.error(e);
    }
}

async function selectConversation(conv) {
    currentConversation = conv;
    chatHistory = [];
    chatMode = false;
    currentQuote = null;
    document.getElementById("conv-subject").textContent = conv.subject || "(sans objet)";
    const msgResp = await fetch("/api/conversations/" + conv.id + "/messages");
    const msgData = await msgResp.json();
    conversationMessages = msgData._results || [];
    messagesContext = conversationMessages.map(m => {
        const from = m.author ? (m.author.first_name || "") + " " + (m.author.last_name || "") : "Inconnu";
        const body = stripHtml(m.body || "");
        const date = formatDate(m.created_at);
        return "[" + date + "] " + from + ":\n" + body;
    }).join("\n---\n");

    // Render email thread as HTML (exclude drafts)
    const thread = document.getElementById("email-thread");
    thread.innerHTML = "";
    conversationMessages.filter(m => !m.is_draft).forEach(m => {
        const from = m.author ? (m.author.first_name || "") + " " + (m.author.last_name || "") : "Inconnu";
        const date = formatDate(m.created_at);
        const msgDiv = document.createElement("div");
        msgDiv.className = "email-msg";
        let cleanBody = (m.body || "").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
        msgDiv.innerHTML = '<div class="email-msg-header"><span class="email-msg-author">' + escapeHtml(from) + '</span><span class="email-msg-date">' + escapeHtml(date) + '</span></div><div class="email-msg-body">' + cleanBody + '</div>';
        thread.appendChild(msgDiv);
    });

    document.getElementById("chat-messages").innerHTML = "";
    goToStep(2);

    // Check if a shared draft exists for this conversation
    checkConversationDraft(conv.id);

    // Check quote readiness and update button
    checkQuoteReadiness(conv.id);
}

function renderMarkdown(text) {
    let html = escapeHtml(text);
    // Headings: --- TITLE ---
    html = html.replace(/^---\s*(.+?)\s*---$/gm, '<div class="md-heading">$1</div>');
    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    // List items: - text
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    // Clean up <br> inside <ul>
    html = html.replace(/<br><ul>/g, '<ul>');
    html = html.replace(/<\/ul><br>/g, '</ul>');
    html = html.replace(/<\/li><br><li>/g, '</li><li>');
    return html;
}

function addChatMessage(role, content, showDraftBtn) {
    chatHistory.push({ role, content });
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = "chat-msg " + role;
    let html = role === "assistant" ? renderMarkdown(content) : escapeHtml(content);
    if (role === "assistant" && showDraftBtn !== false) {
        html += '<button class="use-draft-btn" onclick="useDraft(this)">Utiliser comme brouillon</button>';
    }
    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function sendToClaud() {
    const input = document.getElementById("user-input");
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    addChatMessage("user", message);
    const sendBtn = document.getElementById("send-btn");
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="loading"></span> Claude reflechit...';
    try {
        const resp = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                inbox_id: currentInbox ? currentInbox.id : "",
                messages_context: messagesContext,
                chat_history: chatHistory.filter(m => m.role !== "system"),
                user_message: message,
            }),
        });
        const data = await resp.json();
        if (data.error) { addChatMessage("assistant", "Erreur : " + data.error); }
        else { addChatMessage("assistant", data.response); }
    } catch (e) {
        addChatMessage("assistant", "Erreur de connexion avec Claude.");
        console.error(e);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Envoyer";
    }
}

function useDraft(btn) {
    const msgDiv = btn.closest(".chat-msg");
    // Get the raw content from chatHistory (last assistant message before this button)
    const assistantMessages = chatHistory.filter(m => m.role === "assistant");
    const rawContent = assistantMessages[assistantMessages.length - 1]?.content || "";
    // Try to extract just the email draft (look for common patterns)
    let draft = rawContent;
    // Try to find the email body between known markers
    const patterns = [
        /(?:MAIL FINAL|BROUILLON|EMAIL|RÉPONSE)[*:\s-]*\n([\s\S]+?)(?:\n---|\n\*\*[A-Z]|\n[A-Z]\)|$)/i,
        /(?:Objet|Bonjour|Madame|Monsieur|Cher)[\s\S]*$/im,
    ];
    for (const pattern of patterns) {
        const match = draft.match(pattern);
        if (match) {
            draft = (match[1] || match[0]).trim();
            break;
        }
    }
    document.getElementById("draft-content").value = draft;
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.getElementById("step3").classList.add("active");
}

async function sendDraftToFront() {
    const body = document.getElementById("draft-content").value.trim();
    if (!body) return;
    const statusDiv = document.getElementById("draft-status");
    const btn = document.getElementById("send-draft-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> Creation du brouillon...';
    statusDiv.className = "status-message";
    statusDiv.textContent = "";
    try {
        let endpoint = "/api/drafts";
        let payload = {
            conversation_id: currentConversation.id,
            body: body.replace(/\n/g, "<br>"),
        };

        // If we have a quote, use the endpoint that attaches the PDF
        if (currentQuote && currentQuote.pdfUrl) {
            endpoint = "/api/draft-with-quote";
            payload.pdf_url = currentQuote.pdfUrl;
            payload.quote_number = currentQuote.quoteNumber;
        }

        const resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await resp.json();
        if (data.error) { statusDiv.className = "status-message error"; statusDiv.textContent = "Erreur : " + data.error; }
        else {
            draftedConversations.add(currentConversation.id);
            const frontLink = document.getElementById("front-link");
            frontLink.href = "https://app.frontapp.com/open/" + currentConversation.id;
            document.getElementById("success-modal").style.display = "flex";
        }
    } catch (e) {
        statusDiv.className = "status-message error";
        statusDiv.textContent = "Erreur de connexion avec Front.";
        console.error(e);
    } finally {
        btn.disabled = false;
        btn.textContent = "Charger le brouillon dans Front";
    }
}

async function generateQuote() {
    const modal = document.getElementById("quote-modal");
    const loading = document.getElementById("quote-modal-loading");
    const success = document.getElementById("quote-modal-success");
    const errorDiv = document.getElementById("quote-modal-error");
    modal.style.display = "flex";
    loading.style.display = "block";
    success.style.display = "none";
    errorDiv.style.display = "none";

    try {
        // First check if conversation is ready for quote
        const checkResp = await fetch("/api/conversations/" + encodeURIComponent(currentConversation.id) + "/summary");
        const checkData = await checkResp.json();
        if (!checkData.quote_ready) {
            loading.style.display = "none";
            errorDiv.style.display = "block";
            const reason = checkData.quote_ready_reason || "Informations insuffisantes dans la conversation.";
            document.getElementById("quote-error-text").textContent = "Impossible de generer le devis : " + reason;
            addChatMessage("assistant", "Le devis ne peut pas encore etre genere : " + reason, false);
            return;
        }

        // Ask Claude to extract quote data from the conversation
        const extractResp = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                inbox_id: currentInbox ? currentInbox.id : "",
                messages_context: messagesContext,
                chat_history: [],
                user_message: `Extrais les informations de cette conversation pour creer un devis Pennylane.

REGLES IMPORTANTES :
- Pour les filets sur mesure : type="product", unite=m2, quantity=surface totale en m2 (largeur x hauteur x nombre de filets), unitPrice=prix HT au m2.
  La description doit suivre ce format exact : "Quantite : X | Total m2 : Y | Delai de production + livraison : environ 14 jours"
  Le label doit suivre : "COULEUR - LxH m - Description du produit"
- Pour le transport : type="transport", label="Transport sur mesure", unitPrice=prix HT (ex: 19.99), quantity=1
- Pour la remise transport (livraison offerte) : type="transport_discount", label="Remise transport sur mesure", unitPrice=prix negatif (ex: -19.99), quantity=1
- Pour les accessoires ou autres : type="free", quantity=nombre, unitPrice=prix HT unitaire

Reponds UNIQUEMENT avec un JSON valide (sans markdown, sans backticks, sans texte) :
{"customer":{"type":"individual","firstName":"","lastName":"","email":"","phone":"","address":{"street":"","zipCode":"","city":"","country":"FR"}},"lines":[{"type":"product","label":"","quantity":0,"unitPrice":0,"vatRate":"FR_200","description":""}],"subject":"","freeText":""}

Remplis avec les vraies infos. Si un champ est inconnu, mets une chaine vide. Pour type company, ajoute "name" et optionnellement "vatNumber".`,
            }),
        });
        const extractData = await extractResp.json();
        if (extractData.error) throw new Error(extractData.error);

        let quoteData;
        try {
            // Clean response: remove markdown code blocks if present
            let raw = extractData.response.trim();
            raw = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
            quoteData = JSON.parse(raw);
        } catch (e) {
            throw new Error("Claude n'a pas retourne un JSON valide. Reessayez.");
        }

        // Add inbox name for template selection + conversation ID for draft
        quoteData.inboxName = currentInbox ? currentInbox.name : "";
        quoteData.conversationId = currentConversation ? currentConversation.id : "";

        // Call our API to create the quote
        const quoteResp = await fetch("/api/create-quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(quoteData),
        });
        const quoteResult = await quoteResp.json();

        loading.style.display = "none";
        if (quoteResult.error) {
            errorDiv.style.display = "block";
            document.getElementById("quote-error-text").textContent = quoteResult.error;
        } else {
            success.style.display = "block";
            document.getElementById("quote-info").textContent =
                "Devis " + (quoteResult.quoteNumber || "") + " — " + (quoteResult.amount || 0) + " € HT";
            document.getElementById("quote-pdf-link").href = quoteResult.pdfUrl || "#";
            document.getElementById("quote-pdf-link").style.display = quoteResult.pdfUrl ? "" : "none";

            // Store quote info for draft creation
            currentQuote = {
                pdfUrl: quoteResult.pdfUrl || "",
                quoteNumber: quoteResult.quoteNumber || "",
                amount: quoteResult.amount || "0",
            };

            // Pre-fill draft with quote email
            const draftText = "Bonjour,\n\nVeuillez trouver ci-joint votre devis n°" + currentQuote.quoteNumber + ".\n\nPour confirmer votre commande, merci de nous retourner ce devis signe accompagne du reglement par virement bancaire.\n\nNos coordonnees bancaires figurent sur le devis.\n\nNous restons a votre disposition pour toute question.\n\nCordialement";
            document.getElementById("draft-content").value = draftText;

            addChatMessage("assistant", "Devis " + currentQuote.quoteNumber + " cree (" + currentQuote.amount + " € HT). Cliquez sur Fermer pour visualiser et envoyer le brouillon avec le PDF en piece jointe.", false);
        }
    } catch (e) {
        loading.style.display = "none";
        errorDiv.style.display = "block";
        document.getElementById("quote-error-text").textContent = e.message || "Erreur inconnue";
    }
}

function goToQuoteDraft() {
    document.getElementById("quote-modal").style.display = "none";
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    document.getElementById("step3").classList.add("active");
}

function closeQuoteModal() {
    document.getElementById("quote-modal").style.display = "none";
}

function finishAndGoBack() {
    document.getElementById("success-modal").style.display = "none";
    goToStep(1);
}

function showAdminLogin() {
    document.getElementById("admin-modal").style.display = "flex";
    document.getElementById("admin-login-form").style.display = "block";
    document.getElementById("admin-panel").style.display = "none";
    document.getElementById("admin-password").value = "";
    document.getElementById("admin-error").textContent = "";
}

function closeAdminModal() {
    document.getElementById("admin-modal").style.display = "none";
}

async function adminLogin() {
    const pwd = document.getElementById("admin-password").value;
    try {
        const resp = await fetch("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pwd }),
        });
        if (resp.ok) {
            adminPassword = pwd;
            document.getElementById("admin-login-form").style.display = "none";
            document.getElementById("admin-panel").style.display = "block";
            populateAdminInboxSelect();
        } else {
            document.getElementById("admin-error").textContent = "Mot de passe incorrect.";
        }
    } catch (e) {
        document.getElementById("admin-error").textContent = "Erreur de connexion.";
    }
}

async function populateAdminInboxSelect() {
    const select = document.getElementById("admin-inbox-select");
    select.innerHTML = '<option value="">-- Choisir une boite --</option>';
    try {
        const resp = await fetch("/api/inboxes");
        const data = await resp.json();
        (data._results || []).forEach(inbox => {
            const opt = document.createElement("option");
            opt.value = inbox.id;
            opt.textContent = inbox.name;
            select.appendChild(opt);
        });
    } catch (e) { console.error(e); }
}

async function loadInboxConfig() {
    const inboxId = document.getElementById("admin-inbox-select").value;
    const configDiv = document.getElementById("admin-config");
    if (!inboxId) { configDiv.style.display = "none"; return; }
    configDiv.style.display = "block";
    try {
        const resp = await fetch("/api/config/" + encodeURIComponent(inboxId), {
            headers: { "X-Admin-Password": adminPassword },
        });
        const data = await resp.json();
        document.getElementById("admin-instructions").value = data.instructions || "";
        renderAdminFiles(data.files || []);
    } catch (e) { console.error(e); }
}

async function saveAdminInstructions() {
    const inboxId = document.getElementById("admin-inbox-select").value;
    if (!inboxId) return;
    const instructions = document.getElementById("admin-instructions").value;
    try {
        await fetch("/api/config/" + encodeURIComponent(inboxId) + "/instructions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Admin-Password": adminPassword },
            body: JSON.stringify({ instructions }),
        });
        document.getElementById("save-status").textContent = "Sauvegarde !";
        setTimeout(() => { document.getElementById("save-status").textContent = ""; }, 2000);
    } catch (e) { console.error(e); }
}

async function uploadAdminFile() {
    const inboxId = document.getElementById("admin-inbox-select").value;
    if (!inboxId) return;
    const input = document.getElementById("admin-file-upload");
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
        const resp = await fetch("/api/config/" + encodeURIComponent(inboxId) + "/upload", {
            method: "POST",
            headers: { "X-Admin-Password": adminPassword },
            body: formData,
        });
        const data = await resp.json();
        if (data.error) { alert("Erreur: " + data.error); }
        else { loadInboxConfig(); }
    } catch (e) { console.error(e); }
    input.value = "";
}

async function removeAdminFile(filename) {
    const inboxId = document.getElementById("admin-inbox-select").value;
    if (!inboxId) return;
    try {
        await fetch("/api/config/" + encodeURIComponent(inboxId) + "/files/" + encodeURIComponent(filename), {
            method: "DELETE",
            headers: { "X-Admin-Password": adminPassword },
        });
        loadInboxConfig();
    } catch (e) { console.error(e); }
}

function renderAdminFiles(files) {
    const list = document.getElementById("admin-files-list");
    list.innerHTML = "";
    files.forEach(f => {
        const tag = document.createElement("span");
        tag.className = "file-tag";
        tag.innerHTML = escapeHtml(f) + ' <span class="remove-file" onclick="removeAdminFile(\'' + escapeHtml(f) + '\')">&times;</span>';
        list.appendChild(tag);
    });
}

async function checkQuoteReadiness(convId) {
    const quoteBtn = document.querySelector(".btn-quote");
    if (!quoteBtn) return;
    try {
        const resp = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/summary");
        const data = await resp.json();
        if (data.quote_ready) {
            quoteBtn.style.opacity = "1";
            quoteBtn.title = "Generer le devis PDF — les informations sont completes";
        } else {
            quoteBtn.style.opacity = "0.5";
            quoteBtn.title = data.quote_ready_reason || "Informations insuffisantes pour generer le devis";
        }
    } catch (e) {}
}

async function checkConversationDraft(convId) {
    const generateBtn = document.getElementById("generate-btn");
    const draftInfoBar = document.getElementById("draft-info-bar");
    try {
        const resp = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/drafts");
        const data = await resp.json();
        if (data.has_draft) {
            draftInfoBar.style.display = "";
            generateBtn.textContent = "Modifier le brouillon avec Claude";
        } else {
            draftInfoBar.style.display = "none";
            generateBtn.textContent = "Generer un brouillon avec Claude";
        }
    } catch (e) {
        draftInfoBar.style.display = "none";
        generateBtn.textContent = "Generer un brouillon avec Claude";
    }
}

async function checkDraft(convId, el) {
    try {
        const resp = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/drafts");
        const data = await resp.json();
        if (data.has_draft) { el.style.display = "inline-block"; }
    } catch (e) {}
}

async function fetchSummary(convId, el, quoteBadge) {
    try {
        const resp = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/summary");
        const data = await resp.json();
        el.textContent = data.summary || "";
        el.classList.remove("summary-loading");
        if (data.quote_ready && quoteBadge) {
            quoteBadge.style.display = "inline-block";
        }
    } catch (e) { el.textContent = ""; }
}

function escapeHtml(str) { const div = document.createElement("div"); div.textContent = str; return div.innerHTML; }
function stripHtml(html) { const cleaned = html.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ""); const tmp = document.createElement("div"); tmp.innerHTML = cleaned; return tmp.textContent || tmp.innerText || ""; }
function formatDate(ts) { if (!ts) return ""; const d = new Date(ts * 1000); return d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour:"2-digit", minute:"2-digit" }); }

document.getElementById("user-input").addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendToClaud(); }
});

loadInboxes();

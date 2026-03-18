import os
import requests
from datetime import datetime, timedelta

PENNYLANE_API_URL = "https://app.pennylane.com/api/external/v2"
PENNYLANE_API_TOKEN = os.getenv("PENNYLANE_API_TOKEN", "")

# Mapping inbox name → (store code, template ID)
STORE_CONFIG = {
    "le filet":     ("LFC",  253634),
    "le voile":     ("LVO",  877143),
    "tarnnetz":     ("TAR",  257174),
    "ma toile coco":("COCO", 257180),
    "het":          ("HET",  257162),
    "red":          ("RED",  257168),
    "rete":         ("RETE", 861190),
    "mon ombrage":  ("MON",  883869),
    "univers":      ("UNI",  883875),
}


def get_store_config(inbox_name):
    """Returns (store_code, template_id) for an inbox name."""
    name_lower = inbox_name.lower()
    for key, (code, tmpl) in STORE_CONFIG.items():
        if key in name_lower:
            return code, tmpl
    return "LFC", 253634


def _headers():
    return {
        "Authorization": f"Bearer {PENNYLANE_API_TOKEN}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def find_customer_by_email(email):
    """Search for an existing customer by email in Pennylane."""
    import json as _json
    try:
        resp = requests.get(
            f"{PENNYLANE_API_URL}/customers",
            headers=_headers(),
            params={
                "filter": _json.dumps([
                    {"field": "emails", "operator": "in", "value": [email]}
                ])
            },
            timeout=15,
        )
        if resp.status_code == 200:
            items = resp.json().get("items", [])
            if items:
                return items[0]
    except Exception:
        pass
    return None


def create_customer(customer_data):
    """Create a customer in Pennylane. Returns the customer object."""
    customer_type = customer_data.get("type", "individual")

    payload = {}
    if customer_data.get("email"):
        payload["emails"] = [customer_data["email"]]
    if customer_data.get("phone"):
        payload["phone"] = customer_data["phone"]

    address = customer_data.get("address", {})
    if address and any(address.values()):
        payload["billing_address"] = {
            "address": address.get("street", ""),
            "postal_code": address.get("zipCode", ""),
            "city": address.get("city", ""),
            "country_alpha2": address.get("country", "FR"),
        }

    if customer_type == "company":
        endpoint = f"{PENNYLANE_API_URL}/company_customers"
        payload["name"] = customer_data.get("name", "")
        if customer_data.get("vatNumber"):
            payload["vat_number"] = customer_data["vatNumber"]
    else:
        endpoint = f"{PENNYLANE_API_URL}/individual_customers"
        payload["first_name"] = customer_data.get("firstName", "")
        payload["last_name"] = customer_data.get("lastName", "")

    try:
        resp = requests.post(
            endpoint,
            headers=_headers(),
            json=payload,
            timeout=15,
        )
        if resp.status_code in (200, 201):
            return resp.json()
        return {"error": f"Erreur creation client: {resp.text}"}
    except Exception as e:
        return {"error": str(e)}


def create_quote(customer=None, customer_id=None, lines=None,
                 subject=None, deadline=None, free_text=None,
                 special_mention=None, external_ref=None,
                 inbox_name=None, **kwargs):
    """Create a quote in Pennylane. Returns quote info with PDF URL."""
    if not PENNYLANE_API_TOKEN:
        return {"error": "PENNYLANE_API_TOKEN non configure"}

    # Resolve customer
    resolved_customer_id = customer_id
    if not resolved_customer_id and customer:
        # Try to find existing customer by email
        if customer.get("email"):
            existing = find_customer_by_email(customer["email"])
            if existing:
                resolved_customer_id = existing["id"]

        # Create customer if not found
        if not resolved_customer_id:
            result = create_customer(customer)
            if result.get("error"):
                return result
            resolved_customer_id = result.get("id")

    if not resolved_customer_id:
        return {"error": "Impossible de creer ou trouver le client"}

    if not lines or len(lines) == 0:
        return {"error": "Au moins une ligne de devis requise"}

    # Product IDs
    PRODUCT_ID_FILET = 14369303    # filets sur mesure → unité m²
    PRODUCT_ID_GENERIC = 16822267  # transport, accessoires, remises → unité pièce

    # Build invoice lines
    invoice_lines = []
    for line in lines:
        line_type = line.get("type", "free")

        if line_type == "product":
            product_id = PRODUCT_ID_FILET
            unit = "m2"
        else:
            product_id = PRODUCT_ID_GENERIC
            unit = "piece"

        il = {
            "label": line.get("label", ""),
            "quantity": line.get("quantity", 1),
            "raw_currency_unit_price": str(line.get("unitPrice", 0)),
            "vat_rate": line.get("vatRate", "FR_200"),
            "unit": line.get("unit", unit),
            "product_id": product_id,
        }
        if line.get("description"):
            il["description"] = line["description"]
        invoice_lines.append(il)

    # Build quote payload
    today = datetime.now().strftime("%Y-%m-%d")
    default_deadline = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")

    # Get template ID based on inbox/store
    _, template_id = get_store_config(inbox_name or "")

    payload = {
        "date": today,
        "deadline": deadline or default_deadline,
        "customer_id": resolved_customer_id,
        "currency": "EUR",
        "invoice_lines": invoice_lines,
        "quote_template_id": template_id,
    }

    if subject:
        payload["pdf_invoice_subject"] = subject
    if free_text:
        payload["pdf_invoice_free_text"] = free_text
    if special_mention:
        payload["special_mention"] = special_mention
    if external_ref:
        payload["external_reference"] = external_ref

    try:
        resp = requests.post(
            f"{PENNYLANE_API_URL}/quotes",
            headers=_headers(),
            json=payload,
            timeout=30,
        )

        if resp.status_code in (200, 201):
            data = resp.json()
            return {
                "success": True,
                "quoteId": data.get("id"),
                "quoteNumber": data.get("quote_number") or data.get("label"),
                "pdfUrl": data.get("public_file_url"),
                "amount": data.get("currency_amount_before_tax"),
                "amountTTC": data.get("currency_amount"),
                "status": data.get("status"),
            }
        else:
            try:
                err = resp.json()
                msg = err.get("message", resp.text)
            except Exception:
                msg = resp.text
            return {"error": f"Erreur Pennylane ({resp.status_code}): {msg}"}

    except requests.exceptions.Timeout:
        return {"error": "Timeout - Pennylane ne repond pas"}
    except requests.exceptions.ConnectionError:
        return {"error": "Impossible de contacter Pennylane"}
    except Exception as e:
        return {"error": str(e)}

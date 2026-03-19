interface MailPreviewProps {
  storeCode: string;
  customerName: string;
  customerEmail: string;
  subject: string;
}

export default function MailPreview({ storeCode, customerName, customerEmail, subject }: MailPreviewProps) {
  return (
    <div className="mail-preview">
      <div className="mail-preview-header">
        <span className="store-badge">{storeCode}</span>
        <span className="plugin-title">ZEPHYR</span>
      </div>
      <div className="mail-preview-details">
        {customerName && <p className="customer-name">{customerName}</p>}
        {customerEmail && <p className="customer-email">{customerEmail}</p>}
        <p className="mail-subject">{subject}</p>
      </div>
    </div>
  );
}

import type { Locale } from '@uboce/contracts';

type Vars = Record<string, string>;

interface Template {
  /** Event-driven notifications: also push to the user's devices (in-app is always kept). */
  push?: boolean;
  /** Mobile route opened when the notification is tapped. */
  route?: (vars: Vars) => string;
  /** Contains a one-time link: sent immediately and never stored. */
  sensitive?: boolean;
  /** `title` doubles as the email subject; SMS uses `body` only. */
  text: Record<Locale, { title: (v: Vars) => string; body: (v: Vars) => string }>;
}

const VERIFICATION_TEXT: Record<Locale, Record<string, string>> = {
  en: {
    approved: 'Your verification was approved.',
    rejected: 'Your verification was not approved. You can start a new one.',
    needs_information: 'Your verification needs more information.',
    suspended: 'Your verification was suspended. Contact support.',
    expired: 'Your verification has expired. Please verify again.',
  },
  am: {
    approved: 'ማረጋገጫዎ ጸድቋል።',
    rejected: 'ማረጋገጫዎ አልጸደቀም። አዲስ መጀመር ይችላሉ።',
    needs_information: 'ማረጋገጫዎ ተጨማሪ መረጃ ይፈልጋል።',
    suspended: 'ማረጋገጫዎ ታግዷል። ድጋፍ ሰጪን ያነጋግሩ።',
    expired: 'ማረጋገጫዎ ጊዜው አልፏል። እባክዎ እንደገና ያረጋግጡ።',
  },
};

const ORDER_TEXT: Record<Locale, Record<string, string>> = {
  en: {
    ready_for_pickup: 'Your order is ready to collect.',
    uncollected: 'The order was not collected in time.',
    delivery_failed: 'Delivery failed; the supplier will retry or contact you.',
    fulfilled: 'The order is complete.',
    exception: 'The order needs attention.',
  },
  am: {
    ready_for_pickup: 'ትዕዛዝዎ ለመውሰድ ዝግጁ ነው።',
    uncollected: 'ትዕዛዙ በጊዜው አልተወሰደም።',
    delivery_failed: 'ማድረሱ አልተሳካም፤ አቅራቢው እንደገና ይሞክራል ወይም ያነጋግርዎታል።',
    fulfilled: 'ትዕዛዙ ተጠናቋል።',
    exception: 'ትዕዛዙ ትኩረት ይፈልጋል።',
  },
};

// English + Amharic (PRD 10). Amharic copy needs review by a native speaker before launch.
// Push previews show on lock screens, so pushes never carry identity or payment details (PRD 5.16).
export const TEMPLATES = {
  // ---- Account (email, sent via the internal messages API) --------------------
  email_verification: {
    sensitive: true,
    text: {
      en: {
        title: () => 'Confirm your email address',
        body: (v) => `Hi ${v.name},\n\nConfirm your email address for UBOCE:\n${v.link}\n\nThis link expires in 48 hours.`,
      },
      am: {
        title: () => 'ኢሜይል አድራሻዎን ያረጋግጡ',
        body: (v) => `ሰላም ${v.name}፣\n\nየUBOCE ኢሜይል አድራሻዎን ያረጋግጡ፦\n${v.link}\n\nይህ ሊንክ በ48 ሰዓታት ውስጥ ጊዜው ያልፋል።`,
      },
    },
  },
  password_reset: {
    sensitive: true,
    text: {
      en: {
        title: () => 'Reset your password',
        body: (v) =>
          `Hi ${v.name},\n\nUse this link to set a new UBOCE password:\n${v.link}\n\nIt expires in 30 minutes. If you didn't ask for this, you can ignore this message.`,
      },
      am: {
        title: () => 'የይለፍ ቃልዎን ይቀይሩ',
        body: (v) =>
          `ሰላም ${v.name}፣\n\nአዲስ የUBOCE የይለፍ ቃል ለማዘጋጀት ይህን ሊንክ ይጠቀሙ፦\n${v.link}\n\nበ30 ደቂቃ ውስጥ ጊዜው ያልፋል። ይህን ካልጠየቁ ይህን መልእክት ችላ ማለት ይችላሉ።`,
      },
    },
  },
  organization_invitation: {
    sensitive: true,
    text: {
      en: {
        title: (v) => `Join ${v.organizationName} on UBOCE`,
        body: (v) => `${v.inviterName} invited you to join ${v.organizationName} as ${v.role}. Accept: ${v.link}`,
      },
      am: {
        title: (v) => `${v.organizationName}ን በUBOCE ይቀላቀሉ`,
        body: (v) => `${v.inviterName} ${v.organizationName}ን እንደ ${v.role} እንዲቀላቀሉ ጋብዘዎታል። ለመቀበል፦ ${v.link}`,
      },
    },
  },

  // ---- Events (in-app + push) ---------------------------------------------------
  welcome: {
    text: {
      en: { title: () => 'Welcome to UBOCE', body: (v) => `Hi ${v.name}, your account is ready.` },
      am: { title: () => 'እንኳን ወደ UBOCE በደህና መጡ', body: (v) => `ሰላም ${v.name}፣ መለያዎ ዝግጁ ነው።` },
    },
  },
  organization_created: {
    push: true,
    route: (v) => `/organizations/${v.organizationId}`,
    text: {
      en: { title: () => 'Organization created', body: (v) => `${v.organizationName} is set up. Invite your team to get started.` },
      am: { title: () => 'ድርጅት ተፈጥሯል', body: (v) => `${v.organizationName} ተዘጋጅቷል። ለመጀመር ቡድንዎን ይጋብዙ።` },
    },
  },
  membership_added: {
    push: true,
    route: (v) => `/organizations/${v.organizationId}`,
    text: {
      en: { title: () => 'You were added to an organization', body: (v) => `You have been given the ${v.role} role.` },
      am: { title: () => 'ወደ ድርጅት ተጨምረዋል', body: (v) => `የ${v.role} ሚና ተሰጥቶዎታል።` },
    },
  },
  membership_revoked: {
    push: true,
    text: {
      en: { title: () => 'Organization access removed', body: () => 'Your access to an organization has been removed.' },
      am: { title: () => 'የድርጅት መዳረሻ ተወግዷል', body: () => 'ወደ አንድ ድርጅት የነበረዎት መዳረሻ ተወግዷል።' },
    },
  },
  rfq_published: {
    push: true,
    route: (v) => `/rfqs/${v.rfqId}`,
    text: {
      en: { title: () => 'New request for quotation', body: (v) => `A buyer requested quotes for "${v.title}". Respond by ${v.deadline}.` },
      am: { title: () => 'አዲስ የዋጋ ጥያቄ', body: (v) => `አንድ ገዢ ለ"${v.title}" ዋጋ ጠይቋል። እስከ ${v.deadline} ድረስ ምላሽ ይስጡ።` },
    },
  },
  quotation_submitted: {
    push: true,
    route: (v) => `/rfqs/${v.rfqId}`,
    text: {
      en: { title: () => 'New quotation received', body: (v) => `A supplier quoted ${v.total} ${v.currency} on your request.` },
      am: { title: () => 'አዲስ የዋጋ ማቅረቢያ ደርሷል', body: (v) => `አንድ አቅራቢ በጥያቄዎ ላይ ${v.total} ${v.currency} አቅርቧል።` },
    },
  },
  purchase_order_created: {
    push: true,
    route: (v) => `/sales-orders/${v.orderId}`,
    text: {
      en: { title: () => 'New purchase order', body: (v) => `Order ${v.orderNumber} for ${v.total} ${v.currency} is waiting for your confirmation.` },
      am: { title: () => 'አዲስ የግዢ ትዕዛዝ', body: (v) => `${v.total} ${v.currency} የሆነ ትዕዛዝ ${v.orderNumber} ማረጋገጫዎን እየጠበቀ ነው።` },
    },
  },
  purchase_order_confirmed: {
    push: true,
    route: (v) => `/purchase-orders/${v.orderId}`,
    text: {
      en: { title: () => 'Order confirmed', body: (v) => `The supplier confirmed order ${v.orderNumber}.` },
      am: { title: () => 'ትዕዛዝ ተረጋግጧል', body: (v) => `አቅራቢው ትዕዛዝ ${v.orderNumber}ን አረጋግጧል።` },
    },
  },
  purchase_order_cancelled: {
    push: true,
    route: (v) => `/purchase-orders/${v.orderId}`,
    text: {
      en: { title: () => 'Order cancelled', body: (v) => `Order ${v.orderNumber} was cancelled.` },
      am: { title: () => 'ትዕዛዝ ተሰርዟል', body: (v) => `ትዕዛዝ ${v.orderNumber} ተሰርዟል።` },
    },
  },
  stock_reservation_failed: {
    push: true,
    route: (v) => `/sales-orders/${v.orderId}`,
    text: {
      en: { title: () => 'Order needs attention', body: () => 'Stock could not be reserved for a confirmed order. Check inventory.' },
      am: { title: () => 'ትዕዛዝ ትኩረት ይፈልጋል', body: () => 'ለተረጋገጠ ትዕዛዝ ክምችት መያዝ አልተቻለም። ክምችቱን ያረጋግጡ።' },
    },
  },
  shipment_dispatched: {
    push: true,
    route: (v) => `/shipments/${v.shipmentId}`,
    text: {
      en: { title: () => 'Shipment on its way', body: () => 'A shipment for your order has been dispatched.' },
      am: { title: () => 'ጭነት ተልኳል', body: () => 'ለትዕዛዝዎ የሚሆን ጭነት ተልኳል።' },
    },
  },
  delivery_confirmed: {
    push: true,
    route: (v) => `/shipments/${v.shipmentId}`,
    text: {
      en: { title: () => 'Delivery confirmed', body: (v) => (v.complete === 'true' ? 'The buyer confirmed full delivery.' : 'The buyer confirmed a partial delivery.') },
      am: { title: () => 'ርክክብ ተረጋግጧል', body: (v) => (v.complete === 'true' ? 'ገዢው ሙሉ ርክክብ አረጋግጧል።' : 'ገዢው ከፊል ርክክብ አረጋግጧል።') },
    },
  },
  invoice_issued: {
    push: true,
    route: (v) => `/invoices/${v.invoiceId}`,
    text: {
      en: { title: () => 'New invoice', body: (v) => `Invoice ${v.invoiceNumber} is due ${v.dueDate}.` },
      am: { title: () => 'አዲስ ደረሰኝ', body: (v) => `ደረሰኝ ${v.invoiceNumber} እስከ ${v.dueDate} ድረስ መከፈል አለበት።` },
    },
  },
  dispute_opened: {
    push: true,
    route: (v) => `/disputes/${v.disputeId}`,
    text: {
      en: { title: () => 'A dispute was opened', body: () => 'Another organization opened a dispute with you. Review it and respond.' },
      am: { title: () => 'ክርክር ተከፍቷል', body: () => 'ሌላ ድርጅት ከእርስዎ ጋር ክርክር ከፍቷል። ይመልከቱና ምላሽ ይስጡ።' },
    },
  },
  verification_update: {
    push: true,
    route: (v) => `/verification/${v.kind}`,
    text: {
      en: { title: () => 'Verification update', body: (v) => VERIFICATION_TEXT.en[v.decision ?? ''] ?? 'Your verification status changed.' },
      am: { title: () => 'የማረጋገጫ ዝማኔ', body: (v) => VERIFICATION_TEXT.am[v.decision ?? ''] ?? 'የማረጋገጫ ሁኔታዎ ተቀይሯል።' },
    },
  },
  // ---- PRD addendum v1.1 ---------------------------------------------------------
  chat_message: {
    push: true,
    route: (v) => `/messages/${v.conversationId}`,
    text: {
      en: { title: (v) => `${v.organizationName}: ${v.subject}`, body: (v) => v.preview || 'Sent an attachment.' },
      am: { title: (v) => `${v.organizationName}፦ ${v.subject}`, body: (v) => v.preview || 'ፋይል ልኳል።' },
    },
  },
  order_update: {
    push: true,
    route: (v) => `/${v.side === 'supplier' ? 'sales-orders' : 'purchase-orders'}/${v.orderId}`,
    text: {
      en: { title: (v) => `Order ${v.orderNumber}`, body: (v) => ORDER_TEXT.en[v.status ?? ''] ?? `The order is now ${v.status}.` },
      am: { title: (v) => `ትዕዛዝ ${v.orderNumber}`, body: (v) => ORDER_TEXT.am[v.status ?? ''] ?? `ትዕዛዙ አሁን ${v.status} ነው።` },
    },
  },
  shipment_update: {
    push: true,
    route: (v) => `/shipments/${v.shipmentId}`,
    text: {
      en: { title: () => 'Shipment update', body: (v) => (v.status === 'delayed' ? 'A shipment is delayed.' : v.status === 'failed' ? 'A delivery attempt failed.' : `A shipment is now ${v.status}.`) },
      am: { title: () => 'የጭነት ዝማኔ', body: (v) => (v.status === 'delayed' ? 'ጭነት ዘግይቷል።' : v.status === 'failed' ? 'የማድረስ ሙከራ አልተሳካም።' : `ጭነቱ አሁን ${v.status} ነው።`) },
    },
  },
  return_requested: {
    push: true,
    route: (v) => `/returns/${v.returnId}`,
    text: {
      en: { title: () => 'Return requested', body: (v) => `The buyer asked to return goods from order ${v.orderNumber}.` },
      am: { title: () => 'የመመለስ ጥያቄ', body: (v) => `ገዢው ከትዕዛዝ ${v.orderNumber} እቃ ለመመለስ ጠይቋል።` },
    },
  },
  return_update: {
    push: true,
    route: (v) => `/returns/${v.returnId}`,
    text: {
      en: { title: () => 'Return update', body: (v) => `Your return for order ${v.orderNumber} was ${v.status}.` },
      am: { title: () => 'የመመለስ ዝማኔ', body: (v) => `ለትዕዛዝ ${v.orderNumber} ያቀረቡት የመመለስ ጥያቄ ${v.status} ሆኗል።` },
    },
  },
  refund_update: {
    push: true,
    route: (v) => `/refunds/${v.refundId}`,
    text: {
      en: { title: () => 'Refund update', body: (v) => `A refund of ${v.amount} ${v.currency} is ${v.status}.` },
      am: { title: () => 'የገንዘብ ተመላሽ ዝማኔ', body: (v) => `${v.amount} ${v.currency} ተመላሽ ${v.status} ነው።` },
    },
  },
  fee_charged: {
    push: true,
    route: (v) => `/purchase-orders/${v.orderId}`,
    text: {
      en: { title: () => 'Fee charged', body: (v) => `A ${v.kind} of ${v.amount} ${v.currency} applies to order ${v.orderNumber} under the supplier's policy.` },
      am: { title: () => 'ክፍያ ተጥሏል', body: (v) => `በአቅራቢው መመሪያ መሠረት ለትዕዛዝ ${v.orderNumber} ${v.amount} ${v.currency} ክፍያ ተጥሏል።` },
    },
  },
  claim_opened: {
    push: true,
    route: (v) => `/quality/claims/${v.claimId}`,
    text: {
      en: { title: () => 'Quality claim', body: (v) => `A buyer opened a quality claim (${v.reason}). Please respond.` },
      am: { title: () => 'የጥራት ቅሬታ', body: (v) => `ገዢ የጥራት ቅሬታ (${v.reason}) አቅርቧል። እባክዎ ምላሽ ይስጡ።` },
    },
  },
  carrier_request: {
    push: true,
    route: (v) => `/shipments/${v.shipmentId}`,
    text: {
      en: { title: () => 'Shipment to carry', body: (v) => `${v.organizationName} asked you to carry shipment ${v.orderNumber}. Accept or decline.` },
      am: { title: () => 'የሚጓጓዝ ጭነት', body: (v) => `${v.organizationName} ጭነት ${v.orderNumber} እንዲያጓጉዙ ጠይቋል። ይቀበሉ ወይም አይቀበሉ።` },
    },
  },
  carrier_answer: {
    push: true,
    route: (v) => `/shipments/${v.shipmentId}`,
    text: {
      en: { title: () => 'Carrier answered', body: (v) => `The logistics provider ${v.status} shipment ${v.orderNumber}.${v.note ? ` "${v.note}"` : ''}` },
      am: { title: () => 'አጓጓዡ ምላሽ ሰጥቷል', body: (v) => `አጓጓዡ ጭነት ${v.orderNumber} ${v.status === 'accepted' ? 'ተቀብሏል' : 'አልተቀበለም'}።` },
    },
  },
  review_published: {
    push: false,
    route: () => '/reviews',
    text: {
      en: { title: () => 'New review', body: (v) => `A buyer rated you ${v.rating}/5.` },
      am: { title: () => 'አዲስ ግምገማ', body: (v) => `ገዢ ${v.rating}/5 ሰጥቶዎታል።` },
    },
  },
} satisfies Record<string, Template>;

export type TemplateKey = keyof typeof TEMPLATES;

export const isTemplateKey = (key: string): key is TemplateKey => Object.hasOwn(TEMPLATES, key);

export function render(key: TemplateKey, locale: string, vars: Vars) {
  const template: Template = TEMPLATES[key];
  const lang: Locale = locale === 'am' ? 'am' : 'en';
  const text = template.text[lang];
  return {
    locale: lang,
    title: text.title(vars),
    body: text.body(vars),
    route: template.route?.(vars),
    push: !!template.push,
    sensitive: !!template.sensitive,
  };
}

/** For stored records of email/SMS: enough to recognise, not enough to harvest. */
export function maskAddress(address: string) {
  const at = address.indexOf('@');
  if (at > 0) return `${address[0]}***${address.slice(at)}`;
  return `${address.slice(0, 5)}****${address.slice(-2)}`;
}

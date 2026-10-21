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

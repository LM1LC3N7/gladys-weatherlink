// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why a source or a station has no fresh value. */
export const REASONS = {
  refused: { en: 'API key or secret refused', fr: "clé ou secret d'API refusé" },
  denied: { en: 'not accessible with these keys', fr: 'non accessible avec ces clés' },
  limited: { en: 'too many requests (pause)', fr: 'trop de requêtes (pause)' },
  busy: { en: 'service unavailable (pause)', fr: 'service indisponible (pause)' },
  failed: { en: 'no answer', fr: 'pas de réponse' },
  invalid: { en: 'not a WeatherLink answer', fr: "réponse qui n'est pas celle de WeatherLink" },
  stale: { en: 'no recent reading', fr: 'pas de mesure récente' },
};

export const reason = (kind) => REASONS[kind] ?? REASONS.failed;

const INVALID = {
  address: { en: 'address not understood', fr: 'adresse non comprise' },
  duplicate: { en: 'address entered twice', fr: 'adresse saisie deux fois' },
};

export const T = {
  notConfiguredCloud: {
    en: 'Enter the API key and the API secret (v2) of your WeatherLink account.',
    fr: "Saisissez la clé d'API et le secret d'API (v2) de votre compte WeatherLink.",
  },
  oneKeyMissing: {
    en: 'Both are needed: the API key and the API secret (v2).',
    fr: "Les deux sont nécessaires : la clé d'API et le secret d'API (v2).",
  },
  keysInvalid: {
    en: 'API key or secret not valid: it holds a line break or a character WeatherLink does not use. Copy it again from weatherlink.com.',
    fr: "Clé ou secret d'API non valide : il contient un retour à la ligne ou un caractère que WeatherLink n'utilise pas. Copiez-le à nouveau depuis weatherlink.com.",
  },
  notConfiguredLocal: {
    en: 'Enter the address (IP) of your WeatherLink Live or AirLink.',
    fr: "Saisissez l'adresse (IP) de votre WeatherLink Live ou AirLink.",
  },
  invalidSlots: (invalid) => ({
    en: invalid.map((i) => `Address ${i.slot} ignored: ${INVALID[i.why].en}`).join('. '),
    fr: invalid.map((i) => `Adresse ${i.slot} ignorée : ${INVALID[i.why].fr}`).join('. '),
  }),
  refusedHelp: {
    en: 'WeatherLink refused the API key or secret: check them on weatherlink.com (Account, API Key v2); one new try every 6 hours until they change.',
    fr: "WeatherLink a refusé la clé ou le secret d'API : vérifiez-les sur weatherlink.com (Account, API Key v2) ; un nouvel essai toutes les 6 heures jusqu'à ce qu'ils changent.",
  },
  moreStations: (n, max) => ({
    en: `${n} more station(s) of the account not read (at most ${max}).`,
    fr: `${n} autre(s) station(s) du compte non lue(s) (${max} au plus).`,
  }),
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  /** The connected status: what is read, how often, and what fails. */
  ok: ({ stations, interval, failing = [] }) => {
    let en = `${stations} WeatherLink station(s), read every ${interval} min.`;
    let fr = `${stations} station(s) WeatherLink, lue(s) toutes les ${interval} min.`;
    if (failing.length > 0) {
      en += ` Without value: ${failing.map((f) => `${f.name} (${reason(f.kind).en})`).join(', ')}.`;
      fr += ` Sans valeur : ${failing.map((f) => `${f.name} (${reason(f.kind).fr})`).join(', ')}.`;
    }
    return { en, fr };
  },
};

// src/selectors.js

export const SEL = {
  // Grid/kaart container (ad cards in zoekresultaten)
  card: '[role="article"], div.x1lliihq.x1n2onr6', // fallback generiek; we filteren later op detail-link aanwezigheid

  // Binnen een kaart:
  pageName: 'a[role="link"][href*="/ads/library/?active_status"], a[role="link"][href*="ads/library/?id="]',
  detailLink: 'a[href*="ads/library/?id="]',
  // Reach label lijkt vaak een badge/tekst dichtbij statistieken
  reachText: 'span:has-text("reached"), span:has-text("bereik"), span:has-text("portée")',
  // CTA/product link in kaart: externe link (geen facebook/instagram domein)
  anyLink: 'a[href^="http"]'
};

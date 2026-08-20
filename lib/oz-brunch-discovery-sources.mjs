/**
 * Curated editorial radar used by the v1.0a curated discovery runtime.
 * These are discovery surfaces, not evidence guarantees.
 */
export const CURATED_DISCOVERY_SOURCE_POOL = Object.freeze([
  Object.freeze({ id: "design-co-kr", lane: "domestic_editorial", name: "DESIGN", url: "https://design.co.kr/article/" }),
  Object.freeze({ id: "designdb", lane: "domestic_editorial", name: "DesignDB", url: "https://designdb.com/?menuno=1434&cate=&order=new&period=&key=community&search_type=&keyword=&writer=&pageIndex=1&sphereCode=&comm=null#gsc.tab=0" }),
  Object.freeze({ id: "designcompass", lane: "domestic_editorial", name: "Design Compass", url: "https://designcompass.org/article/" }),
  Object.freeze({ id: "surfit", lane: "domestic_editorial", name: "Surfit", url: "https://surfit.io", search_hint: "site:surfit.io 디자인 OR 브랜딩 OR UX" }),
  Object.freeze({ id: "yozm-design", lane: "domestic_editorial", name: "요즘IT Design", url: "https://yozm.wishket.com/magazine/list/design/" }),
  Object.freeze({ id: "careet", lane: "domestic_editorial", name: "Careet", url: "https://www.careet.net" }),
  Object.freeze({ id: "toss-design", lane: "domestic_design_team", name: "Toss Design/Tech", url: "https://toss.tech/", search_hint: "site:toss.tech 디자인 OR UX OR 제품" }),
  Object.freeze({ id: "daangn-design", lane: "domestic_design_team", name: "당근 Design", url: "https://medium.com/daangn", search_hint: "site:medium.com/daangn 디자인 OR UX OR 제품" }),
  Object.freeze({ id: "ohouse-design", lane: "domestic_design_team", name: "오늘의집 Design/Product", url: "https://www.bucketplace.com/", search_hint: "site:bucketplace.com 디자인 OR UX OR 제품" }),
  Object.freeze({ id: "its-nice-that", lane: "overseas_editorial", name: "It's Nice That", url: "https://www.itsnicethat.com/articles" }),
  Object.freeze({ id: "creative-boom", lane: "overseas_editorial", name: "Creative Boom", url: "https://www.creativeboom.com/" }),
  Object.freeze({ id: "brand-new", lane: "overseas_editorial", name: "Brand New / UnderConsideration", url: "https://www.underconsideration.com/brandnew/" }),
  Object.freeze({ id: "fast-company-design", lane: "overseas_editorial", name: "Fast Company Design", url: "https://www.fastcompany.com/design" }),
  Object.freeze({ id: "dieline", lane: "overseas_editorial", name: "Dieline", url: "https://thedieline.com/" }),
  Object.freeze({ id: "creative-bloq", lane: "overseas_editorial", name: "Creative Bloq", url: "https://www.creativebloq.com/" }),
  Object.freeze({ id: "core77", lane: "overseas_editorial", name: "Core77", url: "https://www.core77.com/" }),
  Object.freeze({ id: "arxiv-hc", lane: "academic", name: "arXiv cs.HC", url: "https://arxiv.org/list/cs.HC/recent", freshnessDays: 30 }),
  Object.freeze({ id: "acm-hci", lane: "academic", name: "ACM Digital Library HCI", url: "https://dl.acm.org/conference/chi", freshnessDays: 30 }),
  Object.freeze({ id: "semantic-scholar", lane: "academic", name: "Semantic Scholar", url: "https://www.semanticscholar.org/", freshnessDays: 30 })
]);

export function curatedDiscoverySourcePoolForPrompt(sources = CURATED_DISCOVERY_SOURCE_POOL) {
  return sources.map((source) => ({ ...source }));
}

export function curatedDiscoverySourcePoolForLane(lane) {
  if (lane === "domestic") {
    return CURATED_DISCOVERY_SOURCE_POOL.filter((source) => source.lane === "domestic_editorial" || source.lane === "domestic_design_team").map((source) => ({ ...source }));
  }
  if (lane === "overseas") {
    return CURATED_DISCOVERY_SOURCE_POOL.filter((source) => source.lane === "overseas_editorial" || source.lane === "academic").map((source) => ({ ...source }));
  }
  return curatedDiscoverySourcePoolForPrompt();
}

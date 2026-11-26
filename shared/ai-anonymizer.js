(function (global) {
  "use strict";

  const VAULT_VERSION = 1;
  const VAULT_STORAGE_KEY = "sc-ai-privacy-vault-v1";
  const VAULT_BRAND = Symbol.for("sc.ai.privacy.vault");

  const ENTITY_PREFIXES = Object.freeze({
    company: "COMP",
    factory: "FAC",
    sales_factory: "SFAC",
    market: "MKT",
    diagram: "BOM",
    bom_node: "BNODE",
    material: "MAT",
    product: "PROD",
    lane: "LANE",
    batch: "BAT",
    shipment: "SHP",
    fact: "EVT",
    curve: "CRV",
    carrier: "CARR",
    port: "PORT",
    assessment_item: "AITEM",
    entity: "ENT"
  });

  const PREFIX_LIST = Object.values(ENTITY_PREFIXES);
  const ALIAS_EXACT_RE = new RegExp(`^(?:${PREFIX_LIST.join("|")})_\\d{3,}$`);
  const ALIAS_GLOBAL_RE = new RegExp(`\\b(?:${PREFIX_LIST.join("|")})_\\d{3,}\\b`, "g");

  function getStore() {
    if (global.SCDataStore) return global.SCDataStore;
    if (typeof require === "function") return require("../storage/data-store.js");
    return null;
  }

  function isAlias(value) {
    return typeof value === "string" && ALIAS_EXACT_RE.test(value.trim());
  }

  function findAliasesInText(text) {
    if (typeof text !== "string" || !text) return [];
    const matches = text.match(ALIAS_GLOBAL_RE);
    return matches ? Array.from(new Set(matches)) : [];
  }

  function isVaultInstance(value) {
    return Boolean(value && typeof value === "object" && value[VAULT_BRAND] === true);
  }

  /**
   * Create a local-only stable anonymization vault.
   * All mapping tables stay inside private closure memory and are NEVER exported to external models.
   */
  function createVault(options) {
    const opts = options || {};
    const persist = opts.persist === true;
    const storage = persist ? (opts.storage || (typeof localStorage !== "undefined" ? localStorage : null)) : null;

    // Private mapping tables (closure-scoped, never enumerable)
    const rawToAlias = new Map();       // `${type}:${rawId}` -> alias
    const aliasToRecord = new Map();    // alias -> { alias, type, rawId, displayName, meta }
    const rawIdToKeys = new Map();      // rawId -> Set(`${type}:${rawId}`)
    const counters = Object.create(null);
    const sensitiveTerms = new Map();   // normalizedTerm -> { term, category, alias, type, rawId }
    const bomToSalesFactory = new Map();
    const salesToBomFactory = new Map();

    function nextAlias(type) {
      const normalizedType = Object.prototype.hasOwnProperty.call(ENTITY_PREFIXES, type) ? type : "entity";
      const prefix = ENTITY_PREFIXES[normalizedType];
      const next = (counters[normalizedType] || 0) + 1;
      counters[normalizedType] = next;
      return `${prefix}_${String(next).padStart(3, "0")}`;
    }

    function saveIfPersistent() {
      if (!persist || !storage) return;
      try {
        storage.setItem(VAULT_STORAGE_KEY, JSON.stringify(exportLocalBackup()));
      } catch (_) {
        // Non-fatal local cache failure
      }
    }

    function registerSensitiveTerm(term, info) {
      if (typeof term !== "string") return;
      const trimmed = term.trim();
      if (!trimmed || trimmed.length < 2) return;
      // Avoid indexing ultra-short generic strings like "CN", "US", "台", "件" as sensitive text terms
      if (trimmed.length <= 2 && /^[A-Za-z0-9_-]+$/.test(trimmed)) return;
      const key = `${info.category}:${trimmed.toLowerCase()}`;
      if (!sensitiveTerms.has(key)) {
        sensitiveTerms.set(key, {
          term: trimmed,
          category: info.category || "identity.entity_name",
          alias: info.alias || null,
          type: info.type || null,
          rawId: info.rawId || null
        });
      }
    }

    function getOrCreateAlias(type, rawId, info) {
      if (rawId === null || rawId === undefined || rawId === "") return null;
      const strId = String(rawId);
      // If caller already passed a known alias of ours, return it directly
      if (aliasToRecord.has(strId)) return strId;

      const normalizedType = Object.prototype.hasOwnProperty.call(ENTITY_PREFIXES, type) ? type : "entity";
      const compositeKey = `${normalizedType}:${strId}`;
      let alias = rawToAlias.get(compositeKey);
      let created = false;

      if (!alias) {
        alias = nextAlias(normalizedType);
        rawToAlias.set(compositeKey, alias);
        aliasToRecord.set(alias, {
          alias,
          type: normalizedType,
          rawId: strId,
          displayName: info?.displayName ? String(info.displayName) : "",
          meta: info?.meta ? Object.assign({}, info.meta) : {}
        });
        if (!rawIdToKeys.has(strId)) rawIdToKeys.set(strId, new Set());
        rawIdToKeys.get(strId).add(compositeKey);
        created = true;
      } else if (info) {
        const rec = aliasToRecord.get(alias);
        if (info.displayName && !rec.displayName) rec.displayName = String(info.displayName);
        if (info.meta && typeof info.meta === "object") Object.assign(rec.meta, info.meta);
      }

      // Register raw ID itself for text leak detection if it could carry sensitive meaning
      if (strId.length >= 3) {
        registerSensitiveTerm(strId, {
          category: "internal.raw_id",
          alias,
          type: normalizedType,
          rawId: strId
        });
      }

      if (info) {
        if (info.displayName) {
          const cat = normalizedType === "market" ? "identity.market_name"
            : (normalizedType === "material" || normalizedType === "product") ? "identity.product_name"
            : "identity.entity_name";
          registerSensitiveTerm(info.displayName, { category: cat, alias, type: normalizedType, rawId: strId });
        }
        if (Array.isArray(info.sensitiveValues)) {
          for (const item of info.sensitiveValues) {
            if (!item || !item.value) continue;
            registerSensitiveTerm(String(item.value), {
              category: item.category || "sensitive.free_text",
              alias,
              type: normalizedType,
              rawId: strId
            });
          }
        }
      }

      if (created) saveIfPersistent();
      return alias;
    }

    function registerCrossFactoryLink(bomFactoryId, salesNodeId) {
      if (!bomFactoryId || !salesNodeId) return;
      const b = String(bomFactoryId);
      const s = String(salesNodeId);
      bomToSalesFactory.set(b, s);
      salesToBomFactory.set(s, b);
    }

    /**
     * Resolve polymorphic raw target IDs (e.g. fact.targetId) to the exact same alias
     * already assigned to that shipment/batch/factory/market.
     */
    function resolveRawTargetAlias(rawTargetId, preferredTypes) {
      if (rawTargetId === null || rawTargetId === undefined || rawTargetId === "") return null;
      const strId = String(rawTargetId);
      if (aliasToRecord.has(strId)) return strId;

      const order = Array.isArray(preferredTypes) && preferredTypes.length
        ? preferredTypes
        : ["shipment", "batch", "sales_factory", "market", "factory", "company", "lane", "product", "diagram", "bom_node", "material", "fact"];

      for (const t of order) {
        const key = `${t}:${strId}`;
        if (rawToAlias.has(key)) return rawToAlias.get(key);
      }

      const existingKeys = rawIdToKeys.get(strId);
      if (existingKeys && existingKeys.size > 0) {
        const firstKey = existingKeys.values().next().value;
        return rawToAlias.get(firstKey);
      }

      return getOrCreateAlias("entity", strId);
    }

    /**
     * Translate an input filter ID that may be EITHER an anonymous alias OR a raw ID
     * back to the real raw ID locally before querying SCAIQuery.
     */
    function translateInputId(expectedTypes, idOrAlias) {
      if (idOrAlias === null || idOrAlias === undefined || idOrAlias === "") return null;
      const str = String(idOrAlias);
      const rec = aliasToRecord.get(str);
      if (!rec) return str; // Already a raw ID (or unknown string)
      if (!expectedTypes) return rec.rawId;
      const list = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
      if (list.includes(rec.type)) return rec.rawId;
      // Allow cross-module factory alias translation when querying sales by BOM factory alias or vice versa
      if (rec.type === "factory" && list.includes("sales_factory") && bomToSalesFactory.has(rec.rawId)) {
        return bomToSalesFactory.get(rec.rawId);
      }
      if (rec.type === "sales_factory" && list.includes("factory") && salesToBomFactory.has(rec.rawId)) {
        return salesToBomFactory.get(rec.rawId);
      }
      return rec.rawId;
    }

    /**
     * Strictly read-only indexing of business data into local vault.
     * Ensures deterministic aliases regardless of query order, and populates local sensitive dictionary.
     */
    function indexFromRawData(sources) {
      const src = sources || {};
      const bom = src.bomRaw || null;
      const sales = src.salesRaw || null;
      const manifest = src.manifest || null;

      if (manifest && manifest.links) {
        for (const [bf, sn] of Object.entries(manifest.links.bomFactoryToSalesNode || {})) {
          registerCrossFactoryLink(bf, sn);
        }
      }

      if (bom && typeof bom === "object") {
        for (const cid of Object.keys(bom.companies || {}).sort()) {
          const c = bom.companies[cid];
          if (!c) continue;
          const sensitiveValues = [];
          if (c.contact) sensitiveValues.push({ value: c.contact, category: "sensitive.contact" });
          if (c.location) sensitiveValues.push({ value: c.location, category: "sensitive.address" });
          if (c.extraFields && typeof c.extraFields === "object") {
            for (const v of Object.values(c.extraFields)) {
              if (typeof v === "string" && v.trim().length >= 4) {
                sensitiveValues.push({ value: v, category: "sensitive.free_text" });
              }
            }
          }
          getOrCreateAlias("company", cid, { displayName: c.name || "", sensitiveValues });
        }

        for (const fid of Object.keys(bom.factories || {}).sort()) {
          const f = bom.factories[fid];
          if (!f) continue;
          const sensitiveValues = [];
          if (f.contact) sensitiveValues.push({ value: f.contact, category: "sensitive.contact" });
          if (f.location) sensitiveValues.push({ value: f.location, category: "sensitive.address" });
          if (f.extraFields && typeof f.extraFields === "object") {
            for (const v of Object.values(f.extraFields)) {
              if (typeof v === "string" && v.trim().length >= 4) {
                sensitiveValues.push({ value: v, category: "sensitive.free_text" });
              }
            }
          }
          getOrCreateAlias("factory", fid, {
            displayName: f.name || "",
            meta: { companyId: f.companyId || null },
            sensitiveValues
          });
        }

        for (const mid of Object.keys(bom.materials || {}).sort()) {
          const m = bom.materials[mid];
          if (!m) continue;
          const sensitiveValues = [];
          if (m.code) sensitiveValues.push({ value: m.code, category: "identity.product_code" });
          getOrCreateAlias("material", mid, { displayName: m.name || "", sensitiveValues });
        }

        for (const d of (Array.isArray(bom.diagrams) ? bom.diagrams.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))) : [])) {
          if (!d || !d.id) continue;
          const root = bom.nodes?.[d.rootNodeId];
          const rootMat = root ? bom.materials?.[root.materialId] : null;
          getOrCreateAlias("diagram", d.id, { displayName: rootMat?.name || "" });
        }

        for (const nid of Object.keys(bom.nodes || {}).sort()) {
          const n = bom.nodes[nid];
          if (!n) continue;
          const mat = bom.materials?.[n.materialId];
          getOrCreateAlias("bom_node", nid, { displayName: mat?.name || "" });
        }
      }

      if (sales && typeof sales === "object") {
        for (const pid of Object.keys(sales.products || {}).sort()) {
          const p = sales.products[pid];
          if (!p) continue;
          const sensitiveValues = [];
          if (p.skuCode) sensitiveValues.push({ value: p.skuCode, category: "identity.product_code" });
          getOrCreateAlias("product", pid, { displayName: p.name || "", sensitiveValues });
        }

        for (const nid of Object.keys(sales.nodes || {}).sort()) {
          const n = sales.nodes[nid];
          if (!n) continue;
          const nodeType = n.kind === "market" ? "market" : "sales_factory";
          if (n.kind === "source" && n.bomFactoryId) {
            registerCrossFactoryLink(n.bomFactoryId, nid);
            getOrCreateAlias("factory", n.bomFactoryId);
          }
          getOrCreateAlias(nodeType, nid, {
            displayName: n.name || "",
            meta: {
              region: n.region || "",
              bomFactoryId: n.bomFactoryId || null,
              bomCompanyId: n.bomCompanyId || null
            }
          });
        }

        for (const lid of Object.keys(sales.lanes || {}).sort()) {
          const l = sales.lanes[lid];
          if (!l) continue;
          const sensitiveValues = [];
          if (l.defaultCarrier) sensitiveValues.push({ value: l.defaultCarrier, category: "identity.carrier" });
          getOrCreateAlias("lane", lid, { displayName: l.name || "", sensitiveValues });
        }

        for (const bid of Object.keys(sales.batches || {}).sort()) {
          const b = sales.batches[bid];
          if (!b) continue;
          const sensitiveValues = [];
          if (b.code) sensitiveValues.push({ value: b.code, category: "sensitive.document_number" });
          getOrCreateAlias("batch", bid, { displayName: b.code || bid, sensitiveValues });
        }

        for (const sid of Object.keys(sales.shipments || {}).sort()) {
          const s = sales.shipments[sid];
          if (!s) continue;
          const sensitiveValues = [];
          for (const docField of ["code", "trackingNumber", "blNumber", "containerNo", "voyageNo"]) {
            if (s[docField]) sensitiveValues.push({ value: s[docField], category: "sensitive.document_number" });
          }
          if (s.carrier) sensitiveValues.push({ value: s.carrier, category: "identity.carrier" });
          getOrCreateAlias("shipment", sid, { displayName: s.code || sid, sensitiveValues });
        }

        for (const f of (Array.isArray(sales.facts) ? sales.facts : [])) {
          if (!f || !f.eventId) continue;
          const sensitiveValues = [];
          if (f.actor && !["user", "system", "ai_agent"].includes(f.actor)) {
            sensitiveValues.push({ value: f.actor, category: "sensitive.contact" });
          }
          getOrCreateAlias("fact", f.eventId, { displayName: `${f.kind || "event"}@${f.date || ""}`, sensitiveValues });
        }
      }
    }

    function indexFromStore(ctx) {
      const Store = getStore();
      if (!Store) return;
      const manifest = Store.loadManifest(ctx);
      const bomPart = manifest.partitions.some(p => p.id === "bom/entities")
        ? Store.readPartition("bom/entities", ctx)
        : null;
      const salesMaster = manifest.partitions.some(p => p.id === "sales/master")
        ? Store.readPartition("sales/master", ctx)
        : null;

      const salesRaw = salesMaster ? {
        products: salesMaster.products || {},
        nodes: salesMaster.nodes || {},
        lanes: salesMaster.lanes || {},
        batches: {},
        shipments: {},
        facts: []
      } : null;

      if (salesRaw) {
        for (const meta of manifest.partitions) {
          if (meta.domain === "sales" && meta.kind === "monthly") {
            const mp = Store.readPartition(meta.id, ctx);
            if (!mp) continue;
            Object.assign(salesRaw.batches, mp.batches || {});
            Object.assign(salesRaw.shipments, mp.shipments || {});
            if (Array.isArray(mp.facts)) salesRaw.facts.push(...mp.facts);
          }
        }
      }

      indexFromRawData({ bomRaw: bomPart, salesRaw, manifest });
    }

    function resolveAlias(alias) {
      if (typeof alias !== "string") return null;
      const rec = aliasToRecord.get(alias.trim());
      if (!rec) return null;
      const out = {
        alias: rec.alias,
        type: rec.type,
        rawId: rec.rawId,
        displayName: rec.displayName || rec.rawId,
        meta: Object.assign({}, rec.meta)
      };
      if (rec.type === "factory" && bomToSalesFactory.has(rec.rawId)) {
        const snId = bomToSalesFactory.get(rec.rawId);
        out.linkedSalesNodeId = snId;
        out.linkedSalesAlias = rawToAlias.get(`sales_factory:${snId}`) || null;
      } else if (rec.type === "sales_factory" && salesToBomFactory.has(rec.rawId)) {
        const bfId = salesToBomFactory.get(rec.rawId);
        out.linkedBomFactoryId = bfId;
        out.linkedBomFactoryAlias = rawToAlias.get(`factory:${bfId}`) || null;
      }
      return out;
    }

    function getAliasFor(type, rawId) {
      if (rawId === null || rawId === undefined) return null;
      return rawToAlias.get(`${type}:${String(rawId)}`) || null;
    }

    function getSensitiveDictionary() {
      // Return longest terms first for accurate greedy matching
      return Array.from(sensitiveTerms.values()).sort((a, b) => b.term.length - a.term.length);
    }

    function formatResolvedLabel(rec, mode) {
      const label = rec.displayName || rec.rawId;
      if (mode === "annotated") return `${label} (${rec.alias})`;
      if (mode === "id_and_name") return `${label} [${rec.rawId}]`;
      return label;
    }

    /**
     * Restore anonymous aliases inside free text returned by AI back to local real names.
     */
    function rehydrateText(text, rehydrateOpts) {
      const mode = rehydrateOpts?.mode || "name";
      if (typeof text !== "string" || !text) {
        return { text: String(text ?? ""), resolvedRefs: [], unresolvedRefs: [] };
      }
      const resolvedMap = new Map();
      const unresolvedSet = new Set();

      const restored = text.replace(ALIAS_GLOBAL_RE, (token) => {
        const rec = resolveAlias(token);
        if (!rec) {
          unresolvedSet.add(token);
          return token;
        }
        resolvedMap.set(token, rec);
        return formatResolvedLabel(rec, mode);
      });

      return {
        text: restored,
        resolvedRefs: Array.from(resolvedMap.values()),
        unresolvedRefs: Array.from(unresolvedSet)
      };
    }

    /**
     * Restore anonymous entity references in structured AI JSON responses locally.
     * Never mutates the input value.
     * Modes:
     * - "name" (default): replaces alias tokens with user-recognizable display names
     * - "annotated": replaces alias tokens with "真实名称 (COMP_001)"
     * - "detailed_object": converts standalone alias values / ref objects into { alias, type, rawId, displayName }
     */
    function rehydrateStructured(value, rehydrateOpts) {
      const mode = rehydrateOpts?.mode || "name";
      const resolvedMap = new Map();
      const unresolvedSet = new Set();

      function walk(node) {
        if (node === null || node === undefined) return node;
        if (typeof node === "string") {
          const trimmed = node.trim();
          if (isAlias(trimmed)) {
            const rec = resolveAlias(trimmed);
            if (!rec) {
              unresolvedSet.add(trimmed);
              return node;
            }
            resolvedMap.set(trimmed, rec);
            if (mode === "detailed_object") return rec;
            return formatResolvedLabel(rec, mode);
          }
          // Text containing embedded aliases
          if (ALIAS_GLOBAL_RE.test(node)) {
            ALIAS_GLOBAL_RE.lastIndex = 0;
            const res = rehydrateText(node, { mode: mode === "detailed_object" ? "annotated" : mode });
            for (const r of res.resolvedRefs) resolvedMap.set(r.alias, r);
            for (const u of res.unresolvedRefs) unresolvedSet.add(u);
            return res.text;
          }
          return node;
        }
        if (Array.isArray(node)) {
          return node.map(item => walk(item));
        }
        if (typeof node === "object") {
          // Structured reference convention: { entityRef: "COMP_001" } or { alias: "COMP_001" }
          if ((typeof node.entityRef === "string" && isAlias(node.entityRef)) ||
              (typeof node.alias === "string" && isAlias(node.alias) && Object.keys(node).length <= 2)) {
            const token = (node.entityRef || node.alias).trim();
            const rec = resolveAlias(token);
            if (rec) {
              resolvedMap.set(token, rec);
              if (mode === "detailed_object") return rec;
              return Object.assign({}, node, {
                resolvedName: rec.displayName,
                resolvedRawId: rec.rawId,
                resolvedType: rec.type
              });
            }
            unresolvedSet.add(token);
          }
          const out = {};
          for (const [k, v] of Object.entries(node)) {
            let nextKey = k;
            if (isAlias(k)) {
              const rec = resolveAlias(k);
              if (rec) {
                resolvedMap.set(k, rec);
                nextKey = formatResolvedLabel(rec, mode === "detailed_object" ? "annotated" : mode);
              } else {
                unresolvedSet.add(k);
              }
            }
            out[nextKey] = walk(v);
          }
          return out;
        }
        return node;
      }

      const data = walk(value);
      return {
        data,
        resolvedRefs: Array.from(resolvedMap.values()),
        unresolvedRefs: Array.from(unresolvedSet)
      };
    }

    function exportLocalBackup() {
      const records = [];
      for (const rec of aliasToRecord.values()) {
        records.push({
          alias: rec.alias,
          type: rec.type,
          rawId: rec.rawId,
          displayName: rec.displayName,
          meta: rec.meta
        });
      }
      return {
        localOnly: true,
        neverSendToExternalModel: true,
        version: VAULT_VERSION,
        counters: Object.assign({}, counters),
        records,
        crossLinks: {
          bomToSalesFactory: Object.fromEntries(bomToSalesFactory.entries())
        }
      };
    }

    function importLocalBackup(backup) {
      if (!backup || typeof backup !== "object" || backup.version !== VAULT_VERSION) {
        throw new Error("无效的本地匿名映射表备份");
      }
      rawToAlias.clear();
      aliasToRecord.clear();
      rawIdToKeys.clear();
      sensitiveTerms.clear();
      bomToSalesFactory.clear();
      salesToBomFactory.clear();
      for (const k of Object.keys(counters)) delete counters[k];

      Object.assign(counters, backup.counters || {});
      for (const rec of (backup.records || [])) {
        if (!rec || !rec.alias || !rec.type || !rec.rawId) continue;
        const key = `${rec.type}:${rec.rawId}`;
        rawToAlias.set(key, rec.alias);
        aliasToRecord.set(rec.alias, {
          alias: rec.alias,
          type: rec.type,
          rawId: String(rec.rawId),
          displayName: rec.displayName || "",
          meta: rec.meta ? Object.assign({}, rec.meta) : {}
        });
        if (!rawIdToKeys.has(String(rec.rawId))) rawIdToKeys.set(String(rec.rawId), new Set());
        rawIdToKeys.get(String(rec.rawId)).add(key);
        if (rec.displayName) {
          registerSensitiveTerm(rec.displayName, {
            category: rec.type === "market" ? "identity.market_name" : "identity.entity_name",
            alias: rec.alias,
            type: rec.type,
            rawId: String(rec.rawId)
          });
        }
        if (String(rec.rawId).length >= 3) {
          registerSensitiveTerm(String(rec.rawId), {
            category: "internal.raw_id",
            alias: rec.alias,
            type: rec.type,
            rawId: String(rec.rawId)
          });
        }
      }
      for (const [bf, sn] of Object.entries(backup.crossLinks?.bomToSalesFactory || {})) {
        registerCrossFactoryLink(bf, sn);
      }
    }

    function getStats() {
      return {
        totalMappedEntities: aliasToRecord.size,
        countsByType: Object.assign({}, counters),
        indexedSensitiveTermCount: sensitiveTerms.size,
        persistent: persist
      };
    }

    // Hydrate from local storage only if explicitly opted in
    if (persist && storage) {
      try {
        const raw = storage.getItem(VAULT_STORAGE_KEY);
        if (raw) importLocalBackup(JSON.parse(raw));
      } catch (_) {
        // Ignore corrupt vault cache; start fresh in memory
      }
    }

    const vault = Object.create(null);
    Object.defineProperty(vault, VAULT_BRAND, { value: true, enumerable: false });
    Object.assign(vault, {
      getOrCreateAlias,
      getAliasFor,
      resolveRawTargetAlias,
      translateInputId,
      registerCrossFactoryLink,
      registerSensitiveTerm,
      indexFromRawData,
      indexFromStore,
      resolveAlias,
      getSensitiveDictionary,
      rehydrateText,
      rehydrateStructured,
      exportLocalBackup,
      importLocalBackup,
      getStats,
      toJSON: () => "[BLOCKED:LOCAL_PRIVACY_VAULT_NEVER_EXPORT]"
    });
    return Object.freeze(vault);
  }

  const SCAIAnonymizer = Object.freeze({
    VAULT_VERSION,
    VAULT_STORAGE_KEY,
    ENTITY_PREFIXES,
    createVault,
    isVaultInstance,
    isAlias,
    findAliasesInText
  });

  global.SCAIAnonymizer = SCAIAnonymizer;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIAnonymizer;
  }
})(typeof window !== "undefined" ? window : globalThis);

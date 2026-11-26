(function (global) {
  "use strict";

  const PRIVACY_VERSION = "1.0";
  const HONESTY_DISCLAIMER = "自动脱敏仅基于已知主体词典与规则匹配，无法保证自由文本或未登记实体 100% 完全匿名；请勿将本机制视为绝对匿名保证。";

  function getSchema() {
    if (global.SCAIPrivacySchema) return global.SCAIPrivacySchema;
    if (typeof require === "function") return require("./ai-privacy-schema.js");
    throw new Error("未加载 SCAIPrivacySchema (shared/ai-privacy-schema.js)");
  }

  function getAnonymizer() {
    if (global.SCAIAnonymizer) return global.SCAIAnonymizer;
    if (typeof require === "function") return require("./ai-anonymizer.js");
    throw new Error("未加载 SCAIAnonymizer (shared/ai-anonymizer.js)");
  }

  function getQuery() {
    if (global.SCAIQuery) return global.SCAIQuery;
    if (typeof require === "function") return require("./ai-query.js");
    throw new Error("未加载 SCAIQuery (shared/ai-query.js)");
  }

  function getStore() {
    if (global.SCDataStore) return global.SCDataStore;
    if (typeof require === "function") return require("../storage/data-store.js");
    return null;
  }

  const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  /* =========================================================================
     1. Vault Leak Detection (Defense-in-Depth)
     ========================================================================= */
  const VAULT_FORBIDDEN_KEYS = new Set([
    "rawToAlias", "aliasToRecord", "anonymizationMap", "privacyVault", "neverSendToExternalModel"
  ]);

  function detectVaultLeak(value, path, visited) {
    const Anon = getAnonymizer();
    const seen = visited || new Set();
    const curPath = path || "$";

    if (!value || typeof value !== "object") return null;
    if (Anon.isVaultInstance(value)) {
      return { path: curPath, reason: "检测到本地匿名映射 Vault 实例，严禁向外部出口发送" };
    }
    if (seen.has(value)) return null;
    seen.add(value);

    if (value.neverSendToExternalModel === true || (value.localOnly === true && Array.isArray(value.records) && value.crossLinks)) {
      return { path: curPath, reason: "检测到本地匿名映射备份对象，严禁向外部出口发送" };
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = detectVaultLeak(value[i], `${curPath}[${i}]`, seen);
        if (hit) return hit;
      }
      return null;
    }

    for (const [k, v] of Object.entries(value)) {
      if (VAULT_FORBIDDEN_KEYS.has(k)) {
        return { path: `${curPath}.${k}`, reason: `检测到禁止出口的映射字段 ${k}` };
      }
      const hit = detectVaultLeak(v, `${curPath}.${k}`, seen);
      if (hit) return hit;
    }
    return null;
  }

  /* =========================================================================
     2. Manifest-Only Indexing (Preserves Stage 3 Selective Partition Reads!)
     ========================================================================= */
  function indexManifestIntoVault(vault, manifest) {
    if (!vault || !manifest || typeof manifest !== "object") return;
    const links = manifest.links || {};
    for (const [bf, sn] of Object.entries(links.bomFactoryToSalesNode || {})) {
      vault.registerCrossFactoryLink(bf, sn);
    }
    for (const part of (manifest.partitions || [])) {
      const ids = part.entityIds || {};
      if (part.domain === "bom") {
        for (const cid of (ids.companies || []).slice().sort()) vault.getOrCreateAlias("company", cid);
        for (const fid of (ids.factories || []).slice().sort()) vault.getOrCreateAlias("factory", fid);
        for (const did of (ids.diagrams || []).slice().sort()) vault.getOrCreateAlias("diagram", did);
        for (const mid of (ids.materials || []).slice().sort()) vault.getOrCreateAlias("material", mid);
      } else if (part.domain === "sales" && part.kind === "master") {
        for (const fid of (ids.factories || []).slice().sort()) vault.getOrCreateAlias("sales_factory", fid);
        for (const bfid of (ids.bomFactoryIds || []).slice().sort()) vault.getOrCreateAlias("factory", bfid);
        for (const mkid of (ids.markets || []).slice().sort()) vault.getOrCreateAlias("market", mkid);
        for (const pid of (ids.products || []).slice().sort()) vault.getOrCreateAlias("product", pid);
      } else if (part.domain === "sales" && part.kind === "monthly") {
        for (const bid of (ids.batches || []).slice().sort()) vault.getOrCreateAlias("batch", bid);
        for (const rbid of (ids.referencedBatches || []).slice().sort()) vault.getOrCreateAlias("batch", rbid);
        for (const sid of (ids.shipments || []).slice().sort()) vault.getOrCreateAlias("shipment", sid);
        for (const fid of (ids.factories || []).slice().sort()) vault.getOrCreateAlias("sales_factory", fid);
        for (const mkid of (ids.markets || []).slice().sort()) vault.getOrCreateAlias("market", mkid);
      }
    }
  }

  function registerRecordMetadataInVault(vault, schemaName, raw) {
    if (!vault || !raw || typeof raw !== "object") return;
    if (schemaName === "bom_company_summary" || schemaName === "bom_company_detail") {
      const sensitiveValues = [];
      if (raw.contact) sensitiveValues.push({ value: raw.contact, category: "sensitive.contact" });
      if (raw.location) sensitiveValues.push({ value: raw.location, category: "sensitive.address" });
      if (raw.extraFields && typeof raw.extraFields === "object") {
        for (const v of Object.values(raw.extraFields)) {
          if (typeof v === "string" && v.trim().length >= 4) sensitiveValues.push({ value: v, category: "sensitive.free_text" });
        }
      }
      vault.getOrCreateAlias("company", raw.id, { displayName: raw.name || "", sensitiveValues });
    } else if (schemaName === "bom_factory_summary" || schemaName === "bom_factory_detail") {
      const sensitiveValues = [];
      if (raw.contact) sensitiveValues.push({ value: raw.contact, category: "sensitive.contact" });
      if (raw.location) sensitiveValues.push({ value: raw.location, category: "sensitive.address" });
      vault.getOrCreateAlias("factory", raw.id, { displayName: raw.name || "", meta: { companyId: raw.companyId || null }, sensitiveValues });
      if (raw.companyId) vault.getOrCreateAlias("company", raw.companyId, { displayName: raw.companyName || "" });
      if (raw.linkedSalesNodeId) {
        vault.registerCrossFactoryLink(raw.id, raw.linkedSalesNodeId);
        vault.getOrCreateAlias("sales_factory", raw.linkedSalesNodeId);
      }
    } else if (schemaName === "bom_supplier_ref" || schemaName === "bom_receiver_ref") {
      vault.getOrCreateAlias("company", raw.id, { displayName: raw.name || "" });
    } else if (schemaName === "bom_material_summary") {
      const sensitiveValues = raw.code ? [{ value: raw.code, category: "identity.product_code" }] : [];
      vault.getOrCreateAlias("material", raw.id, { displayName: raw.name || "", sensitiveValues });
    } else if (schemaName === "bom_diagram_summary") {
      vault.getOrCreateAlias("diagram", raw.id, { displayName: raw.name || "" });
      if (raw.productId) {
        const sensitiveValues = raw.skuCode ? [{ value: raw.skuCode, category: "identity.product_code" }] : [];
        vault.getOrCreateAlias("material", raw.productId, { displayName: raw.name || "", sensitiveValues });
      }
      if (raw.rootNodeId) vault.getOrCreateAlias("bom_node", raw.rootNodeId, { displayName: raw.name || "" });
    } else if (schemaName === "bom_node_detail") {
      vault.getOrCreateAlias("bom_node", raw.id, { displayName: raw.name || "" });
      if (raw.materialId) {
        const sensitiveValues = raw.code ? [{ value: raw.code, category: "identity.product_code" }] : [];
        vault.getOrCreateAlias("material", raw.materialId, { displayName: raw.name || "", sensitiveValues });
      }
    } else if (schemaName === "sales_node") {
      const nodeType = raw.kind === "market" ? "market" : "sales_factory";
      if (nodeType === "sales_factory" && raw.bomFactoryId) {
        vault.registerCrossFactoryLink(raw.bomFactoryId, raw.id);
        vault.getOrCreateAlias("factory", raw.bomFactoryId);
      }
      vault.getOrCreateAlias(nodeType, raw.id, { displayName: raw.name || "", meta: { region: raw.region || "" } });
    } else if (schemaName === "sales_lane") {
      vault.getOrCreateAlias("lane", raw.id, { displayName: raw.name || "" });
    } else if (schemaName === "sales_batch") {
      const sensitiveValues = raw.code ? [{ value: raw.code, category: "sensitive.document_number" }] : [];
      vault.getOrCreateAlias("batch", raw.id, { displayName: raw.code || raw.id, sensitiveValues });
    } else if (schemaName === "sales_shipment") {
      const sensitiveValues = [];
      for (const f of ["code", "trackingNumber", "blNumber", "containerNo", "voyageNo"]) {
        if (raw[f]) sensitiveValues.push({ value: raw[f], category: "sensitive.document_number" });
      }
      vault.getOrCreateAlias("shipment", raw.id, { displayName: raw.code || raw.id, sensitiveValues });
    } else if (schemaName === "sales_fact") {
      vault.getOrCreateAlias("fact", raw.eventId, { displayName: `${raw.kind || "event"}@${raw.date || ""}` });
    } else if (schemaName === "sales_product") {
      const sensitiveValues = raw.skuCode ? [{ value: raw.skuCode, category: "identity.product_code" }] : [];
      vault.getOrCreateAlias("product", raw.productId, { displayName: raw.name || "", sensitiveValues });
    }
  }

  /* =========================================================================
     3. Text Inspection & Guard (User Input, History, Free Text, Errors, Logs)
     ========================================================================= */
  function isAsciiWordChar(ch) {
    if (!ch) return false;
    const code = ch.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
  }

  function findTermOccurrences(text, term, requireWordBoundary) {
    const hits = [];
    if (!text || !term) return hits;
    const lowerText = text.toLowerCase();
    const lowerTerm = term.toLowerCase();
    let idx = 0;
    while (idx <= lowerText.length - lowerTerm.length) {
      const pos = lowerText.indexOf(lowerTerm, idx);
      if (pos < 0) break;
      const end = pos + term.length;
      if (requireWordBoundary) {
        const prev = pos > 0 ? text[pos - 1] : "";
        const next = end < text.length ? text[end] : "";
        if (isAsciiWordChar(prev) || isAsciiWordChar(next)) {
          idx = pos + 1;
          continue;
        }
      }
      hits.push({ start: pos, end, matched: text.slice(pos, end) });
      idx = end;
    }
    return hits;
  }

  const TEXT_PATTERNS = [
    {
      kind: "credential",
      category: "sensitive.credential",
      hardBlock: true,
      placeholder: "[REDACTED_SECRET]",
      regex: /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,}|(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)\s*[:=]\s*["']?[^\s"',;]{4,}["']?)/gi
    },
    {
      kind: "id_card",
      category: "sensitive.identifier",
      hardBlock: true,
      placeholder: "[REDACTED_ID_CARD]",
      regex: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g
    },
    {
      kind: "uscc",
      category: "sensitive.identifier",
      hardBlock: false,
      placeholder: "[REDACTED_USCC]",
      regex: /\b(?:[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}|TW-\d{6,10})\b/g
    },
    {
      kind: "email",
      category: "sensitive.contact",
      hardBlock: false,
      placeholder: "[REDACTED_EMAIL]",
      regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    },
    {
      kind: "phone",
      category: "sensitive.contact",
      hardBlock: false,
      placeholder: "[REDACTED_PHONE]",
      regex: /(?:\+\d{1,3}[-\s]?\d{1,4}[-\s]?\d{3,4}[-\s]?\d{3,4}|(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})/g
    },
    {
      kind: "document_number",
      category: "sensitive.document_number",
      hardBlock: false,
      placeholder: "[REDACTED_DOC_NO]",
      regex: /\b(?:(?:BL|SHP|BAT|INV|PO|SO|AWB|CMAU|MATU|COSU|CSLU|JJSU|JJSH)-[A-Za-z0-9-]{2,}|[A-Z]{4}\d{7}|V\.\d{3,}[A-Z]?)\b/gi
    },
    {
      kind: "address",
      category: "sensitive.address",
      hardBlock: false,
      placeholder: "[REDACTED_ADDRESS]",
      regex: /[\u4e00-\u9fa5]{2,8}(?:省|市|区|县|镇|街道|园区|工业区|高新区|开发区)[\u4e00-\u9fa5A-Za-z0-9\s]{1,24}(?:路|街|大道|巷|号|栋|座|楼|室)/g
    },
    {
      kind: "commercial_price",
      category: "commercial.cost",
      hardBlock: false,
      placeholder: "[REDACTED_PRICE]",
      regex: /(?:(?:¥|￥|\$|USD|RMB|CNY|EUR)\s*\d+(?:[.,]\d+)?|(?:采购价|单价|报价|成本|底价|售价|利润|运费|费用|价格)[：:\s为约]*\d+(?:[.,]\d+)?\s*(?:元|美元|美金|万|千|RMB|USD|CNY|%)?)/gi
    },
    {
      kind: "commercial_volume",
      category: "commercial.volume",
      hardBlock: false,
      placeholder: "[REDACTED_QTY]",
      regex: /(?:产量|产能|年产能|库存|需求|发运量|数量|销量|订单量|缺口)[：:\s为约]*\d+(?:[.,]\d+)?\s*(?:台|件|套|颗|片|万台|万件|万平米|万只|units?)?/gi
    },
    {
      kind: "internal_id_pattern",
      category: "internal.raw_id",
      hardBlock: false,
      placeholder: "[REDACTED_ID]",
      regex: /\b(?:comp|fac|src|mkt|bat|shp|lane|crv|ws|bom)_[A-Za-z0-9_-]{2,}\b/gi
    },
    {
      kind: "internal_path",
      category: "sensitive.internal_path",
      hardBlock: false,
      placeholder: "[REDACTED_PATH]",
      regex: /(?:\/Users\/|\/home\/|\/var\/|\/tmp\/|[A-Z]:\\)[^\s"'<>|)]+/g
    },
    {
      kind: "unindexed_org",
      category: "identity.unindexed_org",
      hardBlock: false,
      heuristic: true,
      placeholder: "[REDACTED_ORG]",
      regex: /(?:[\u4e00-\u9fa5]{2,14}(?:科技有限公司|股份有限公司|电子有限公司|半导体有限公司|电源有限公司|材料有限公司|有限公司|集团公司|总装一厂|总装二厂|总装厂|模组厂|制造厂|工厂)|\b[A-Z][A-Za-z0-9&.-]{1,24}\s+(?:Inc\.|Ltd\.|LLC|Corp\.|Corporation|GmbH|Co\.,?\s*Ltd\.?))/g
    }
  ];

  function resolveAuthorizedRawIds(vault, idOrAliasList) {
    const set = new Set();
    if (!Array.isArray(idOrAliasList)) return set;
    for (const item of idOrAliasList) {
      if (!item) continue;
      const str = String(item).trim();
      if (!str) continue;
      set.add(str);
      if (vault) {
        const translated = vault.translateInputId(null, str);
        if (translated) set.add(translated);
        const rec = vault.resolveAlias(str);
        if (rec) {
          set.add(rec.rawId);
          if (rec.linkedBomFactoryId) set.add(rec.linkedBomFactoryId);
          if (rec.linkedSalesNodeId) set.add(rec.linkedSalesNodeId);
        }
      }
    }
    return set;
  }

  /**
   * Inspect text for known vault entities, aliases, and heuristic sensitive patterns.
   */
  function inspectText(text, options) {
    const opts = options || {};
    const Anon = getAnonymizer();
    const Schema = getSchema();
    const channel = opts.channel || Schema.CHANNELS.MODEL_CONTEXT;
    const vault = opts.vault || null;
    const str = String(text ?? "");
    const authorizedRawIds = resolveAuthorizedRawIds(vault, opts.authorizedRealNameIds);

    const spans = [];
    const findings = [];

    function overlapsExisting(start, end) {
      return spans.some(s => start < s.end && end > s.start);
    }

    // 1. Check for anonymous aliases (important for WEB_SEARCH where internal tokens must be blocked!)
    const aliases = Anon.findAliasesInText(str);
    for (const alias of aliases) {
      const occs = findTermOccurrences(str, alias, true);
      for (const occ of occs) {
        const isAuthorizedAlias = channel === Schema.CHANNELS.MODEL_CONTEXT;
        if (isAuthorizedAlias) {
          // Preserve valid anonymous aliases so downstream pattern heuristics never corrupt them
          spans.push({ start: occ.start, end: occ.end, replacement: occ.matched });
        }
        findings.push({
          source: "alias_token",
          kind: "anonymous_alias",
          category: "internal.anonymous_alias",
          start: occ.start,
          end: occ.end,
          matched: occ.matched,
          hardBlock: channel === Schema.CHANNELS.WEB_SEARCH,
          authorized: isAuthorizedAlias
        });
      }
    }

    // 2. Dictionary matching from local vault (longest terms first)
    if (vault) {
      const dict = vault.getSensitiveDictionary();
      for (const entry of dict) {
        const isAsciiOnly = /^[A-Za-z0-9_.-]+$/.test(entry.term);
        const occs = findTermOccurrences(str, entry.term, isAsciiOnly);
        for (const occ of occs) {
          if (overlapsExisting(occ.start, occ.end)) continue;
          const isEntityName = entry.category === "identity.entity_name" || entry.category === "identity.market_name";
          const isAuthorizedName = isEntityName && entry.rawId && authorizedRawIds.has(entry.rawId);
          spans.push({
            start: occ.start,
            end: occ.end,
            replacement: isAuthorizedName
              ? occ.matched
              : (entry.alias && channel === Schema.CHANNELS.MODEL_CONTEXT && (isEntityName || entry.category === "internal.raw_id"))
                ? entry.alias
                : `[REDACTED_${entry.category.split(".").pop().toUpperCase()}]`
          });
          findings.push({
            source: "vault_dictionary",
            kind: entry.category,
            category: entry.category,
            alias: entry.alias || null,
            rawId: entry.rawId || null,
            start: occ.start,
            end: occ.end,
            matched: occ.matched,
            authorized: Boolean(isAuthorizedName),
            hardBlock: channel === Schema.CHANNELS.WEB_SEARCH && !isAuthorizedName
          });
        }
      }
    }

    // 3. Pattern-based heuristic scanning
    for (const pat of TEXT_PATTERNS) {
      pat.regex.lastIndex = 0;
      let match;
      while ((match = pat.regex.exec(str)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        // Guard numeric patterns against matching inside longer digit runs (e.g. epoch timestamps)
        if (pat.kind === "phone" || pat.kind === "id_card" || pat.kind === "uscc") {
          const prevChar = start > 0 ? str[start - 1] : "";
          const nextChar = end < str.length ? str[end] : "";
          if (/\d/.test(prevChar) || /\d/.test(nextChar)) continue;
        }
        if (pat.kind === "internal_id_pattern" && Anon.isAlias(match[0])) continue;
        if (overlapsExisting(start, end)) continue;
        // Skip commercial_volume inside model_context if caller explicitly allowed commercial.volume
        const allowedCats = opts.allowedCategories;
        const isCategoryPermitted = allowedCats && allowedCats.has(pat.category) && channel === Schema.CHANNELS.MODEL_CONTEXT;
        if (isCategoryPermitted && (pat.kind === "commercial_volume" || pat.kind === "commercial_price")) {
          continue;
        }
        spans.push({ start, end, replacement: pat.placeholder });
        findings.push({
          source: "pattern_heuristic",
          kind: pat.kind,
          category: pat.category,
          start,
          end,
          matched: match[0],
          authorized: false,
          heuristic: Boolean(pat.heuristic),
          hardBlock: Boolean(pat.hardBlock) || (channel === Schema.CHANNELS.WEB_SEARCH && pat.kind !== "unindexed_org")
        });
      }
    }

    // Build redacted text preview
    spans.sort((a, b) => a.start - b.start);
    let redacted = "";
    let cursor = 0;
    for (const sp of spans) {
      if (sp.start < cursor) continue;
      redacted += str.slice(cursor, sp.start) + sp.replacement;
      cursor = sp.end;
    }
    redacted += str.slice(cursor);

    const unauthorizedFindings = findings.filter(f => !f.authorized);
    const hasHardBlock = unauthorizedFindings.some(f => f.hardBlock);
    const hasHeuristicHits = unauthorizedFindings.some(f => f.source === "pattern_heuristic");
    const isUnstructuredFreeText = ["free_text_note", "user_input", "conversation_history"].includes(opts.sourceKind);
    const unreliableAutoRedaction = Boolean(hasHeuristicHits || isUnstructuredFreeText);

    return {
      channel,
      originalLength: str.length,
      redactedText: redacted,
      findings: unauthorizedFindings,
      authorizedMatches: findings.filter(f => f.authorized),
      hasHardBlock,
      unreliableAutoRedaction
    };
  }

  /**
   * Sanitize free text with explicit block / require_confirmation / allow decision.
   * Never claims 100% reliable anonymization for unstructured free text.
   */
  function sanitizeText(text, options) {
    const opts = options || {};
    const Schema = getSchema();
    const channel = opts.channel || Schema.CHANNELS.MODEL_CONTEXT;
    const sourceKind = opts.sourceKind || "user_input";
    const str = String(text ?? "");

    if (!str.trim()) {
      return {
        allowed: true,
        decision: "allow",
        channel,
        sourceKind,
        text: "",
        redactedPreview: "",
        findings: [],
        requiresConfirmation: false,
        unreliableAutoRedaction: false,
        disclaimers: []
      };
    }

    const inspection = inspectText(str, Object.assign({}, opts, { channel, sourceKind }));

    if (inspection.hasHardBlock) {
      return {
        allowed: false,
        decision: "block",
        channel,
        sourceKind,
        text: null,
        redactedPreview: inspection.redactedText,
        findings: inspection.findings,
        requiresConfirmation: false,
        unreliableAutoRedaction: inspection.unreliableAutoRedaction,
        blockedReason: "检测到高风险敏感内容（凭据/证件号或当前出口策略严禁内容），已自动阻断。",
        disclaimers: [HONESTY_DISCLAIMER]
      };
    }

    const needsConfirmation =
      (inspection.findings.length > 0 && !opts.userConfirmed) ||
      (sourceKind === "free_text_note" && !opts.userConfirmed);

    if (needsConfirmation && opts.strictBlockUnreliable === true) {
      return {
        allowed: false,
        decision: "block",
        channel,
        sourceKind,
        text: null,
        redactedPreview: inspection.redactedText,
        findings: inspection.findings,
        requiresConfirmation: false,
        unreliableAutoRedaction: true,
        blockedReason: "自由文本无法可靠自动脱敏，严格策略下已阻断发送。",
        disclaimers: [HONESTY_DISCLAIMER]
      };
    }

    if (needsConfirmation) {
      return {
        allowed: false,
        decision: "require_confirmation",
        channel,
        sourceKind,
        text: null,
        redactedPreview: inspection.redactedText,
        findings: inspection.findings,
        requiresConfirmation: true,
        confirmationReason: inspection.findings.length > 0
          ? `检测到 ${inspection.findings.length} 处潜在敏感信息，自动脱敏结果需人工复核确认后方可发送。`
          : "自由文本备注可能包含未登记的敏感信息，自动脱敏无法保证完全匿名，需人工确认后方可发送。",
        unreliableAutoRedaction: true,
        disclaimers: [HONESTY_DISCLAIMER]
      };
    }

    return {
      allowed: true,
      decision: "allow",
      channel,
      sourceKind,
      text: inspection.redactedText,
      redactedPreview: inspection.redactedText,
      findings: inspection.findings,
      requiresConfirmation: false,
      unreliableAutoRedaction: inspection.unreliableAutoRedaction,
      disclaimers: inspection.unreliableAutoRedaction ? [HONESTY_DISCLAIMER] : []
    };
  }

  /* =========================================================================
     4. Strict Positive Whitelist Sanitizer for Structured Business Data
     ========================================================================= */
  function createAuditLog() {
    return {
      droppedFields: [],
      blockedFreeTextFields: [],
      disclosedRealNames: [],
      confirmationRequiredFields: [],
      textFindingsCount: 0
    };
  }

  function sanitizeEntity(schemaName, rawObj, runtimeCtx, pathPrefix) {
    const Schema = getSchema();
    if (!rawObj || typeof rawObj !== "object" || Array.isArray(rawObj)) return null;
    const schema = Schema.ENTITY_SCHEMAS[schemaName];
    if (!schema) throw new Error(`未知脱敏白名单结构：${schemaName}`);

    const vault = runtimeCtx.vault;
    const allowedCats = runtimeCtx.allowedCategories;
    const audit = runtimeCtx.audit;
    const path = pathPrefix || schemaName;

    // Register known metadata into local vault before projecting
    registerRecordMetadataInVault(vault, schemaName, rawObj);

    // 1. Audit & deny ALL unknown fields (strict whitelist!)
    for (const k of Object.keys(rawObj)) {
      if (!own(schema, k)) {
        audit.droppedFields.push(`${path}.${k}`);
      }
    }

    const out = {};

    // 2. Project ONLY whitelisted fields that pass category & entity authorization checks
    for (const [field, def] of Object.entries(schema)) {
      // Derived structural counts (e.g. evidenceCount from evidence array)
      if (def.derivedCountFrom) {
        if (allowedCats.has(def.category) && Array.isArray(rawObj[def.derivedCountFrom])) {
          out[field] = rawObj[def.derivedCountFrom].length;
        }
        continue;
      }

      if (!own(rawObj, field) || rawObj[field] === undefined) continue;
      const val = rawObj[field];

      // Determine effective category (e.g. market nodes use identity.market_name)
      const effectiveCategory = (def.marketNameCategory && rawObj.kind === "market")
        ? def.marketNameCategory
        : def.category;

      // Per-entity real-name authorization check
      let fieldAllowed = allowedCats.has(effectiveCategory);
      let disclosedByGrant = false;
      if (!fieldAllowed && def.entityNameOf && (effectiveCategory === "identity.entity_name" || effectiveCategory === "identity.market_name" || effectiveCategory === "identity.product_name")) {
        const refRawId = rawObj[def.entityNameOf.field];
        if (refRawId !== null && refRawId !== undefined && runtimeCtx.authorizedRealNameRawIds.has(String(refRawId))) {
          fieldAllowed = true;
          disclosedByGrant = true;
        }
      }

      // Free-text handling (L4): excluded by default; gated via text guard when explicitly enabled
      if (def.freeText || def.freeTextContainer) {
        if (!fieldAllowed || runtimeCtx.grants?.allowFreeText !== true) {
          audit.blockedFreeTextFields.push(`${path}.${field}`);
          continue;
        }
        if (def.freeText && typeof val === "string") {
          const textRes = sanitizeText(val, {
            vault,
            channel: runtimeCtx.channel,
            sourceKind: "free_text_note",
            authorizedRealNameIds: Array.from(runtimeCtx.authorizedRealNameRawIds),
            allowedCategories: allowedCats,
            userConfirmed: runtimeCtx.userConfirmed === true,
            strictBlockUnreliable: runtimeCtx.strictBlockUnreliable === true
          });
          audit.textFindingsCount += textRes.findings.length;
          if (textRes.decision === "block") {
            runtimeCtx.escalateDecision("block", textRes.blockedReason);
            audit.blockedFreeTextFields.push(`${path}.${field}`);
            continue;
          }
          if (textRes.decision === "require_confirmation") {
            runtimeCtx.escalateDecision("require_confirmation", textRes.confirmationReason);
            audit.confirmationRequiredFields.push({ path: `${path}.${field}`, preview: textRes.redactedPreview, findings: textRes.findings });
            out[field] = textRes.redactedPreview;
            continue;
          }
          out[field] = textRes.text;
          continue;
        }
      }

      if (!fieldAllowed) {
        audit.droppedFields.push(`${path}.${field}`);
        continue;
      }

      if (disclosedByGrant) {
        audit.disclosedRealNames.push({
          path: `${path}.${field}`,
          entityId: vault.getAliasFor(def.entityNameOf.type === "sales_node_auto"
            ? (rawObj.kind === "market" ? "market" : "sales_factory")
            : def.entityNameOf.type, rawObj[def.entityNameOf.field]) || "[AUTHORIZED]"
        });
      }

      // ID pseudonymization
      if (def.idType) {
        if (val === null) {
          out[field] = null;
        } else if (def.idType === "sales_node_auto") {
          const t = rawObj.kind === "market" ? "market" : "sales_factory";
          out[field] = vault.getOrCreateAlias(t, val);
        } else if (def.idType === "target_auto") {
          const preferred = rawObj.kind === "shipment" ? ["shipment"]
            : rawObj.kind === "batch" ? ["batch"]
            : rawObj.kind === "source" ? ["sales_factory"]
            : rawObj.kind === "market" ? ["market"]
            : null;
          out[field] = vault.resolveRawTargetAlias(val, preferred);
        } else {
          out[field] = vault.getOrCreateAlias(def.idType, val);
        }
        continue;
      }

      if (def.idArrayType) {
        out[field] = Array.isArray(val)
          ? val.map(item => vault.getOrCreateAlias(def.idArrayType, item)).filter(Boolean)
          : [];
        continue;
      }

      // Nested object schema
      if (def.nestedSchema) {
        if (val === null) {
          out[field] = null;
        } else if (typeof val === "object" && !Array.isArray(val)) {
          const nested = sanitizeEntity(def.nestedSchema, val, runtimeCtx, `${path}.${field}`);
          if (nested && Object.keys(nested).length > 0) {
            out[field] = nested;
          }
        }
        continue;
      }

      // Nested array of objects schema
      if (def.nestedArraySchema) {
        if (Array.isArray(val)) {
          out[field] = val
            .map((item, idx) => sanitizeEntity(def.nestedArraySchema, item, runtimeCtx, `${path}.${field}[${idx}]`))
            .filter(Boolean);
        }
        continue;
      }

      // Safe primitive copy (never pass through arbitrary unvalidated objects!)
      if (val === null || typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        out[field] = val;
      } else {
        audit.droppedFields.push(`${path}.${field}`);
      }
    }

    return out;
  }

  function sanitizeMeta(meta) {
    if (!meta || typeof meta !== "object") return {};
    const out = {};
    for (const k of ["apiVersion", "manifestVersion", "queriedAt", "partitionsRead", "total", "limit", "offset", "hasMore"]) {
      if (own(meta, k) && meta[k] !== undefined) {
        out[k] = Array.isArray(meta[k]) ? meta[k].slice() : meta[k];
      }
    }
    return out;
  }

  function sanitizePartitionItem(part, vault) {
    const out = {
      id: part.id,
      domain: part.domain,
      kind: part.kind
    };
    if (part.month) out.month = part.month;
    if (part.dateRange) out.dateRange = { from: part.dateRange.from, to: part.dateRange.to };
    if (part.activeDateRange) out.activeDateRange = { from: part.activeDateRange.from, to: part.activeDateRange.to };
    if (part.version !== undefined) out.version = part.version;
    if (part.counts && typeof part.counts === "object") {
      out.counts = Object.assign({}, part.counts);
    }
    if (part.entityIds && typeof part.entityIds === "object") {
      const e = {};
      const ids = part.entityIds;
      const mapArr = (arr, type) => Array.isArray(arr) ? arr.map(x => vault.getOrCreateAlias(type, x)).filter(Boolean) : undefined;
      if (part.domain === "bom") {
        if (ids.companies) e.companies = mapArr(ids.companies, "company");
        if (ids.factories) e.factories = mapArr(ids.factories, "factory");
        if (ids.diagrams) e.diagrams = mapArr(ids.diagrams, "diagram");
        if (ids.materials) e.materials = mapArr(ids.materials, "material");
      } else if (part.domain === "sales") {
        if (ids.factories) e.factories = mapArr(ids.factories, "sales_factory");
        if (ids.bomFactoryIds) e.bomFactoryIds = mapArr(ids.bomFactoryIds, "factory");
        if (ids.markets) e.markets = mapArr(ids.markets, "market");
        if (ids.products) e.products = mapArr(ids.products, "product");
        if (ids.batches) e.batches = mapArr(ids.batches, "batch");
        if (ids.referencedBatches) e.referencedBatches = mapArr(ids.referencedBatches, "batch");
        if (ids.shipments) e.shipments = mapArr(ids.shipments, "shipment");
        if (ids.factTargets) e.factTargets = ids.factTargets.map(x => vault.resolveRawTargetAlias(x)).filter(Boolean);
        if (ids.factFactories) e.factFactories = mapArr(ids.factFactories, "sales_factory");
        if (ids.factMarkets) e.factMarkets = mapArr(ids.factMarkets, "market");
        if (ids.factFactoryByTarget && typeof ids.factFactoryByTarget === "object") {
          const mapped = {};
          for (const [k, v] of Object.entries(ids.factFactoryByTarget)) {
            mapped[vault.resolveRawTargetAlias(k)] = vault.getOrCreateAlias("sales_factory", v);
          }
          e.factFactoryByTarget = mapped;
        }
        if (ids.factMarketByTarget && typeof ids.factMarketByTarget === "object") {
          const mapped = {};
          for (const [k, v] of Object.entries(ids.factMarketByTarget)) {
            mapped[vault.resolveRawTargetAlias(k)] = vault.getOrCreateAlias("market", v);
          }
          e.factMarketByTarget = mapped;
        }
      }
      out.entityIds = e;
    }
    return out;
  }

  function sanitizeDiagramAssessmentsMap(rawAssessments, runtimeCtx, pathPrefix) {
    const out = {};
    if (!rawAssessments || typeof rawAssessments !== "object") return out;
    for (const [rawCompanyId, byMarket] of Object.entries(rawAssessments)) {
      if (!byMarket || typeof byMarket !== "object") continue;
      const compAlias = runtimeCtx.vault.getOrCreateAlias("company", rawCompanyId);
      out[compAlias] = {};
      for (const [marketKey, rec] of Object.entries(byMarket)) {
        if (!rec || typeof rec !== "object") continue;
        out[compAlias][marketKey] = sanitizeEntity(
          "bom_assessment",
          Object.assign({ market: marketKey }, rec),
          runtimeCtx,
          `${pathPrefix}.${compAlias}.${marketKey}`
        );
      }
    }
    return out;
  }

  function sanitizeSimulationPayload(rawSimResult, runtimeCtx) {
    if (!rawSimResult || typeof rawSimResult !== "object") return null;
    const vault = runtimeCtx.vault;

    if (!rawSimResult.ok) {
      const safeErrors = Array.isArray(rawSimResult.errors)
        ? rawSimResult.errors.map(err => sanitizeError(err, { vault }).message)
        : [];
      const safeErrMsg = rawSimResult.error
        ? sanitizeError(rawSimResult.error, { vault }).message
        : undefined;
      return { ok: false, error: safeErrMsg, errors: safeErrors };
    }

    const sim = rawSimResult.simulation;
    if (!sim || typeof sim !== "object") return { ok: true, simulation: null };

    const outSim = {
      today: sim.today || null,
      viewEndDate: sim.viewEndDate || null
    };

    if (sim.kpis) {
      outSim.kpis = sanitizeEntity("simulation_kpis", sim.kpis, runtimeCtx, "simulation.kpis");
    }
    if (sim.costs && runtimeCtx.allowedCategories.has("commercial.cost")) {
      outSim.costs = sanitizeEntity("simulation_costs", sim.costs, runtimeCtx, "simulation.costs");
    }
    if (sim.marketSummaries && typeof sim.marketSummaries === "object") {
      outSim.marketSummaries = {};
      for (const [rawMktId, summary] of Object.entries(sim.marketSummaries)) {
        const mktAlias = vault.getOrCreateAlias("market", rawMktId, { displayName: summary?.name || "" });
        outSim.marketSummaries[mktAlias] = sanitizeEntity(
          "simulation_market_summary",
          Object.assign({ nodeId: rawMktId }, summary),
          runtimeCtx,
          `simulation.marketSummaries.${mktAlias}`
        );
      }
    }
    if (Array.isArray(sim.exceptions)) {
      outSim.exceptions = sim.exceptions.map((ex, idx) =>
        sanitizeEntity("simulation_exception", ex, runtimeCtx, `simulation.exceptions[${idx}]`)
      );
    }

    // Intentionally NEVER expose raw previewWorkspace or baseSimulation.nodeDaily!
    runtimeCtx.audit.droppedFields.push("previewWorkspace");
    return {
      ok: true,
      errors: [],
      simulation: outSim
    };
  }

  /* =========================================================================
     5. Error & Log Sanitization
     ========================================================================= */
  function sanitizeError(errorInput, options) {
    const opts = options || {};
    const rawMsg = errorInput instanceof Error
      ? (errorInput.message || String(errorInput))
      : String(errorInput ?? "");
    const inspected = inspectText(rawMsg, {
      vault: opts.vault || null,
      channel: getSchema().CHANNELS.MODEL_CONTEXT,
      sourceKind: "error",
      authorizedRealNameIds: []
    });
    return {
      sanitized: true,
      message: inspected.redactedText,
      findingsCount: inspected.findings.length,
      stackOmitted: true
    };
  }

  function sanitizeLog(logEntry, options) {
    const opts = options || {};
    const vault = opts.vault || null;
    if (typeof logEntry === "string") {
      const inspected = inspectText(logEntry, {
        vault,
        channel: getSchema().CHANNELS.MODEL_CONTEXT,
        sourceKind: "log",
        authorizedRealNameIds: []
      });
      return {
        sanitized: true,
        entry: inspected.redactedText,
        findingsCount: inspected.findings.length
      };
    }
    if (logEntry && typeof logEntry === "object") {
      if (detectVaultLeak(logEntry)) {
        return { sanitized: true, blocked: true, entry: "[BLOCKED:VAULT_CONTENT_IN_LOG]", findingsCount: 1 };
      }
      const out = {};
      let count = 0;
      const safeKeys = ["level", "timestamp", "event", "channel", "scope", "decision", "message", "error", "code"];
      for (const k of safeKeys) {
        if (!own(logEntry, k) || logEntry[k] === undefined) continue;
        const v = logEntry[k];
        if (typeof v === "string") {
          const ins = inspectText(v, { vault, channel: getSchema().CHANNELS.MODEL_CONTEXT, sourceKind: "log", authorizedRealNameIds: [] });
          out[k] = ins.redactedText;
          count += ins.findings.length;
        } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
          out[k] = v;
        }
      }
      return { sanitized: true, entry: out, findingsCount: count };
    }
    return { sanitized: true, entry: "", findingsCount: 0 };
  }

  /* =========================================================================
     6. Main Privacy Session / Context Factory
     ========================================================================= */
  function createContext(config) {
    const cfg = config || {};
    const Schema = getSchema();
    const Anon = getAnonymizer();
    const Query = getQuery();
    const Store = getStore();

    const vault = cfg.vault || Anon.createVault({
      persist: cfg.persistVault === true,
      storage: cfg.vaultStorage || null
    });

    const queryCtx = {};
    if (cfg.storage) queryCtx.storage = cfg.storage;
    if (cfg.partitionProvider) queryCtx.partitionProvider = cfg.partitionProvider;
    if (cfg.bomRaw !== undefined) queryCtx.bomRaw = cfg.bomRaw;
    if (cfg.salesRaw !== undefined) queryCtx.salesRaw = cfg.salesRaw;

    // Strictly separate policies for MODEL_CONTEXT vs WEB_SEARCH!
    const modelPolicy = {
      scope: cfg.modelPolicy?.scope || cfg.scope || Schema.DEFAULT_SCOPE,
      grants: Object.assign({}, cfg.modelPolicy?.grants || cfg.grants || {})
    };
    const searchPolicy = {
      enabled: cfg.searchPolicy?.enabled !== false,
      authorizedRealNameIds: Array.isArray(cfg.searchPolicy?.authorizedRealNameIds)
        ? cfg.searchPolicy.authorizedRealNameIds.slice()
        : [],
      strictMode: cfg.searchPolicy?.strictMode !== false
    };

    let manifestIndexed = false;
    let fullTextIndexLoaded = false;
    let indexedManifestSig = null;
    let indexedFullSig = null;

    function quickHashStr(s) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(36);
    }

    function computeStoreSignature(qctx) {
      if (!Store) return null;
      if (qctx && (qctx.partitionProvider || qctx.bomRaw !== undefined || qctx.salesRaw !== undefined)) {
        return null;
      }
      const store = (qctx && qctx.storage) || (typeof localStorage !== "undefined" ? localStorage : null);
      if (!store || typeof store.getItem !== "function") return null;
      try {
        const b = store.getItem(Store.STORAGE_KEYS.BOM) || "";
        const s = store.getItem(Store.STORAGE_KEYS.SALES) || "";
        const sl = store.getItem(Store.STORAGE_KEYS.SALES_LEGACY) || "";
        return `${b.length}:${quickHashStr(b)}|${s.length}:${quickHashStr(s)}|${sl.length}:${quickHashStr(sl)}`;
      } catch (_) {
        return null;
      }
    }

    function ensureManifestIndexed(overrideQueryCtx, force) {
      const qctx = overrideQueryCtx || queryCtx;
      const sig = computeStoreSignature(qctx);
      if (!overrideQueryCtx && !force && manifestIndexed) {
        if (sig === null || sig === indexedManifestSig) return;
      }
      if (Store) {
        const loadCtx = (sig !== null && (force || sig !== indexedManifestSig))
          ? Object.assign({}, qctx, { forceRebuild: true })
          : qctx;
        const manifest = Store.loadManifest(loadCtx);
        indexManifestIntoVault(vault, manifest);
        if (!overrideQueryCtx) {
          manifestIndexed = true;
          indexedManifestSig = sig;
        }
      }
    }

    function ensureFullEntityDictionary(overrideQueryCtx, force) {
      const qctx = overrideQueryCtx || queryCtx;
      const sig = computeStoreSignature(qctx);
      if (!overrideQueryCtx && !force && fullTextIndexLoaded) {
        if (sig === null || sig === indexedFullSig) return;
      }
      const indexCtx = (sig !== null && (force || sig !== indexedFullSig))
        ? Object.assign({}, qctx, { forceRebuild: true })
        : qctx;
      vault.indexFromStore(indexCtx);
      if (!overrideQueryCtx) {
        manifestIndexed = true;
        fullTextIndexLoaded = true;
        indexedManifestSig = sig;
        indexedFullSig = sig;
      }
    }

    function invalidateIndex() {
      manifestIndexed = false;
      fullTextIndexLoaded = false;
      indexedManifestSig = null;
      indexedFullSig = null;
    }

    function buildRuntimeCtx(callOpts, channel) {
      const ch = channel || Schema.CHANNELS.MODEL_CONTEXT;
      const scopeName = callOpts?.scope || modelPolicy.scope || Schema.DEFAULT_SCOPE;
      const grants = Object.assign({}, modelPolicy.grants, callOpts?.grants || {});
      if (grants.allowFreeText === true) {
        ensureFullEntityDictionary(callOpts?.queryCtx);
      }
      const allowedCategories = Schema.resolveAllowedCategories(ch, scopeName, grants);
      const authorizedRealNameRawIds = resolveAuthorizedRawIds(vault, grants.authorizedRealNameIds);
      const audit = createAuditLog();
      let decision = "allow";
      const decisionReasons = [];

      function escalateDecision(next, reason) {
        if (next === "block") {
          decision = "block";
          if (reason) decisionReasons.push(reason);
        } else if (next === "require_confirmation" && decision !== "block") {
          decision = "require_confirmation";
          if (reason) decisionReasons.push(reason);
        }
      }

      return {
        channel: ch,
        scope: Schema.getScope(scopeName).name,
        grants,
        allowedCategories,
        authorizedRealNameRawIds,
        userConfirmed: callOpts?.userConfirmed === true,
        strictBlockUnreliable: callOpts?.strictBlockUnreliable === true,
        vault,
        audit,
        escalateDecision,
        getDecision: () => decision,
        getDecisionReasons: () => decisionReasons.slice()
      };
    }

    function finalizeModelResponse(runtimeCtx, data, meta, okFlag, errorStr) {
      const decision = runtimeCtx.getDecision();
      const allowed = okFlag !== false && decision === "allow";
      const out = {
        ok: okFlag !== false,
        allowed,
        decision: okFlag === false ? "error" : decision,
        channel: Schema.CHANNELS.MODEL_CONTEXT,
        scope: runtimeCtx.scope,
        data: decision === "allow" ? data : null,
        meta: sanitizeMeta(meta),
        audit: runtimeCtx.audit
      };
      if (okFlag === false && errorStr) {
        out.error = sanitizeError(errorStr, { vault }).message;
      }
      if (decision === "require_confirmation") {
        out.requiresConfirmation = true;
        out.confirmationReasons = runtimeCtx.getDecisionReasons();
        out.confirmationPreview = data;
        out.disclaimers = [HONESTY_DISCLAIMER];
      } else if (decision === "block") {
        out.blockedReasons = runtimeCtx.getDecisionReasons();
        out.disclaimers = [HONESTY_DISCLAIMER];
      } else if (runtimeCtx.grants?.allowFreeText === true) {
        out.disclaimers = [HONESTY_DISCLAIMER];
      }
      return out;
    }

    function translateQueryParams(params) {
      if (!params || typeof params !== "object") return {};
      const out = Object.assign({}, params);
      if (out.id) out.id = vault.translateInputId(null, out.id);
      if (Array.isArray(out.ids)) out.ids = out.ids.map(x => vault.translateInputId(null, x));
      if (out.companyId) out.companyId = vault.translateInputId("company", out.companyId);
      if (out.factoryId) out.factoryId = vault.translateInputId(["factory", "sales_factory"], out.factoryId);
      if (out.bomFactoryId) out.bomFactoryId = vault.translateInputId("factory", out.bomFactoryId);
      if (out.salesNodeId) out.salesNodeId = vault.translateInputId("sales_factory", out.salesNodeId);
      if (out.marketId) out.marketId = vault.translateInputId("market", out.marketId);
      if (out.diagramId) out.diagramId = vault.translateInputId("diagram", out.diagramId);
      if (out.productId) out.productId = vault.translateInputId(["product", "material"], out.productId);
      if (out.batchId) out.batchId = vault.translateInputId("batch", out.batchId);
      if (out.shipmentId) out.shipmentId = vault.translateInputId("shipment", out.shipmentId);
      return out;
    }

    /* ---------------- Sanitized Read-Only Query Wrappers ---------------- */

    function listPartitions(params, callOpts) {
      const qctx = callOpts?.queryCtx || queryCtx;
      ensureManifestIndexed(qctx);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      const rawRes = Query.listPartitions(params, qctx);
      if (!rawRes.ok) return finalizeModelResponse(runtimeCtx, null, rawRes.meta, false, rawRes.error);

      const bomToSales = {};
      const salesToBom = {};
      for (const [bf, sn] of Object.entries(rawRes.data?.links?.bomFactoryToSalesNode || {})) {
        vault.registerCrossFactoryLink(bf, sn);
        const bfAlias = vault.getOrCreateAlias("factory", bf);
        const snAlias = vault.getOrCreateAlias("sales_factory", sn);
        bomToSales[bfAlias] = snAlias;
        salesToBom[snAlias] = bfAlias;
      }

      const sanitized = {
        partitions: (rawRes.data?.partitions || []).map(p => sanitizePartitionItem(p, vault)),
        links: {
          bomFactoryToSalesNode: bomToSales,
          salesNodeToBomFactory: salesToBom
        }
      };
      return finalizeModelResponse(runtimeCtx, sanitized, rawRes.meta, true);
    }

    function queryBomEntities(params, callOpts) {
      const qctx = callOpts?.queryCtx || queryCtx;
      ensureManifestIndexed(qctx);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      const translated = translateQueryParams(params);
      const rawRes = Query.queryBomEntities(translated, qctx);
      if (!rawRes.ok) return finalizeModelResponse(runtimeCtx, null, rawRes.meta, false, rawRes.error);

      const rows = (rawRes.data || []).map((item, idx) => {
        const schemaName = item.kind === "company" ? "bom_company_summary"
          : item.kind === "factory" ? "bom_factory_summary"
          : "bom_diagram_summary";
        return sanitizeEntity(schemaName, item, runtimeCtx, `bomEntities[${idx}]`);
      });
      return finalizeModelResponse(runtimeCtx, rows, rawRes.meta, true);
    }

    function getBomDetail(params, callOpts) {
      const qctx = callOpts?.queryCtx || queryCtx;
      ensureManifestIndexed(qctx);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      const translated = translateQueryParams(params);
      const rawRes = Query.getBomDetail(translated, qctx);
      if (!rawRes.ok) return finalizeModelResponse(runtimeCtx, null, rawRes.meta, false, rawRes.error);

      const d = rawRes.data || {};
      let sanitized = {};

      if (translated.companyId) {
        sanitized = {
          company: sanitizeEntity("bom_company_detail", d.company, runtimeCtx, "company"),
          factories: (d.factories || []).map((f, i) => sanitizeEntity("bom_factory_detail", f, runtimeCtx, `factories[${i}]`)),
          upstreamSuppliers: (d.upstreamSuppliers || []).map((u, i) => sanitizeEntity("bom_supplier_ref", u, runtimeCtx, `upstreamSuppliers[${i}]`)),
          downstreamReceivers: (d.downstreamReceivers || []).map((r, i) => sanitizeEntity("bom_receiver_ref", r, runtimeCtx, `downstreamReceivers[${i}]`)),
          marketAssessments: (d.marketAssessments || []).map((a, i) => sanitizeEntity("bom_assessment", a, runtimeCtx, `marketAssessments[${i}]`))
        };
      } else if (translated.factoryId) {
        sanitized = {
          factory: sanitizeEntity("bom_factory_detail", d.factory, runtimeCtx, "factory"),
          company: d.company ? sanitizeEntity("bom_company_detail", d.company, runtimeCtx, "company") : null,
          factoryPaths: (d.factoryPaths || []).map((fp, i) => sanitizeEntity("bom_factory_path", fp, runtimeCtx, `factoryPaths[${i}]`)),
          linkedSalesNodeId: d.linkedSalesNodeId ? vault.getOrCreateAlias("sales_factory", d.linkedSalesNodeId) : null
        };
        if (d.factory?.id && d.linkedSalesNodeId) {
          vault.registerCrossFactoryLink(d.factory.id, d.linkedSalesNodeId);
        }
      } else if (translated.diagramId || translated.productId) {
        sanitized = {
          diagramId: vault.getOrCreateAlias("diagram", d.diagramId),
          rootNodeId: vault.getOrCreateAlias("bom_node", d.rootNodeId),
          nodes: (d.nodes || []).map((n, i) => sanitizeEntity("bom_node_detail", n, runtimeCtx, `nodes[${i}]`)),
          assessments: sanitizeDiagramAssessmentsMap(d.assessments, runtimeCtx, "assessments")
        };
      }

      return finalizeModelResponse(runtimeCtx, sanitized, rawRes.meta, true);
    }

    function querySales(params, callOpts) {
      const qctx = callOpts?.queryCtx || queryCtx;
      ensureManifestIndexed(qctx);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      const translated = translateQueryParams(params);
      const rawRes = Query.querySales(translated, qctx);
      if (!rawRes.ok) return finalizeModelResponse(runtimeCtx, null, rawRes.meta, false, rawRes.error);

      const entity = translated.entity || "shipments";
      const rows = (rawRes.data || []).map((item, idx) => {
        if (entity === "factories" || entity === "markets") {
          return sanitizeEntity("sales_node", item, runtimeCtx, `sales.${entity}[${idx}]`);
        }
        if (entity === "lanes") {
          return sanitizeEntity("sales_lane", item, runtimeCtx, `sales.lanes[${idx}]`);
        }
        if (entity === "batches" || (entity === "summary" && item.recordType === "batch")) {
          return sanitizeEntity("sales_batch", item, runtimeCtx, `sales.batches[${idx}]`);
        }
        if (entity === "shipments" || (entity === "summary" && item.recordType === "shipment")) {
          return sanitizeEntity("sales_shipment", item, runtimeCtx, `sales.shipments[${idx}]`);
        }
        if (entity === "facts") {
          return sanitizeEntity("sales_fact", item, runtimeCtx, `sales.facts[${idx}]`);
        }
        runtimeCtx.audit.droppedFields.push(`sales.unknown[${idx}]`);
        return null;
      }).filter(Boolean);

      return finalizeModelResponse(runtimeCtx, rows, rawRes.meta, true);
    }

    function getCrossModuleFactoryView(params, callOpts) {
      const qctx = callOpts?.queryCtx || queryCtx;
      ensureManifestIndexed(qctx);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      const translated = translateQueryParams(params);
      const rawRes = Query.getCrossModuleFactoryView(translated, qctx);
      if (!rawRes.ok) return finalizeModelResponse(runtimeCtx, null, rawRes.meta, false, rawRes.error);

      const d = rawRes.data || {};
      if (d.linked && d.bomFactoryId && d.salesNodeId) {
        vault.registerCrossFactoryLink(d.bomFactoryId, d.salesNodeId);
      }

      const sanitizedBom = d.bom ? {
        factory: sanitizeEntity("bom_factory_detail", d.bom.factory, runtimeCtx, "bom.factory"),
        company: d.bom.company ? sanitizeEntity("bom_company_detail", d.bom.company, runtimeCtx, "bom.company") : null,
        upstreamSuppliers: (d.bom.upstreamSuppliers || []).map((u, i) => sanitizeEntity("bom_supplier_ref", u, runtimeCtx, `bom.upstreamSuppliers[${i}]`)),
        marketAssessments: (d.bom.marketAssessments || []).map((a, i) => sanitizeEntity("bom_assessment", a, runtimeCtx, `bom.marketAssessments[${i}]`))
      } : null;

      const sanitizedSales = d.sales ? {
        factoryNode: sanitizeEntity("sales_node", d.sales.factoryNode, runtimeCtx, "sales.factoryNode"),
        batches: (d.sales.batches || []).map((b, i) => sanitizeEntity("sales_batch", b, runtimeCtx, `sales.batches[${i}]`)),
        batchesTotal: d.sales.batchesTotal,
        shipments: (d.sales.shipments || []).map((s, i) => sanitizeEntity("sales_shipment", s, runtimeCtx, `sales.shipments[${i}]`)),
        shipmentsTotal: d.sales.shipmentsTotal
      } : null;

      const sanitized = {
        linked: Boolean(d.linked),
        bomFactoryId: d.bomFactoryId ? vault.getOrCreateAlias("factory", d.bomFactoryId) : null,
        salesNodeId: d.salesNodeId ? vault.getOrCreateAlias("sales_factory", d.salesNodeId) : null,
        bom: sanitizedBom,
        sales: sanitizedSales
      };

      return finalizeModelResponse(runtimeCtx, sanitized, rawRes.meta, true);
    }

    function simulateSalesActions(actions, simCallOpts) {
      const opts = simCallOpts || {};
      const qctx = opts.queryCtx || queryCtx;
      ensureManifestIndexed(qctx);
      const runtimeCtx = buildRuntimeCtx(opts, Schema.CHANNELS.MODEL_CONTEXT);

      // Translate any anonymous aliases in action targetId / payload back to real IDs locally
      const list = Array.isArray(actions) ? actions : [actions];
      const translatedActions = list.map(act => {
        if (!act || typeof act !== "object") return act;
        const copy = Object.assign({}, act);
        if (copy.targetId) copy.targetId = vault.translateInputId(null, copy.targetId);
        if (copy.payload && typeof copy.payload === "object") {
          const p = Object.assign({}, copy.payload);
          if (p.fromNodeId) p.fromNodeId = vault.translateInputId("sales_factory", p.fromNodeId);
          if (p.toNodeId) p.toNodeId = vault.translateInputId("market", p.toNodeId);
          if (p.sourceNodeId) p.sourceNodeId = vault.translateInputId("sales_factory", p.sourceNodeId);
          if (p.batchId) p.batchId = vault.translateInputId("batch", p.batchId);
          if (p.productId) p.productId = vault.translateInputId("product", p.productId);
          copy.payload = p;
        }
        return copy;
      });

      const rawRes = Query.simulateSalesActions(translatedActions, opts);
      const sanitized = sanitizeSimulationPayload(rawRes, runtimeCtx);
      return finalizeModelResponse(runtimeCtx, sanitized, { apiVersion: Query.API_VERSION, partitionsRead: [] }, Boolean(rawRes && rawRes.ok), rawRes?.error);
    }

    /**
     * Generic on-demand sanitizer for a single business payload of a known schema.
     */
    function sanitizeBusinessPayload(schemaName, rawPayload, callOpts) {
      const vaultLeak = detectVaultLeak(rawPayload);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      if (vaultLeak) {
        runtimeCtx.escalateDecision("block", vaultLeak.reason);
        return finalizeModelResponse(runtimeCtx, null, {}, true);
      }
      const data = Array.isArray(rawPayload)
        ? rawPayload.map((item, idx) => sanitizeEntity(schemaName, item, runtimeCtx, `${schemaName}[${idx}]`))
        : sanitizeEntity(schemaName, rawPayload, runtimeCtx, schemaName);
      return finalizeModelResponse(runtimeCtx, data, {}, true);
    }

    /* ---------------- Model Context Egress Gate (Full Bundle) ---------------- */

    function prepareConversationHistory(messages, callOpts) {
      ensureFullEntityDictionary(callOpts?.queryCtx);
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);
      const list = Array.isArray(messages) ? messages : [];
      const sanitizedMessages = [];
      const allFindings = [];
      let requiresConfirmation = false;
      let blocked = false;
      const reasons = [];

      for (let i = 0; i < list.length; i++) {
        const msg = list[i];
        if (!msg || typeof msg !== "object") continue;
        const leak = detectVaultLeak(msg);
        if (leak) {
          blocked = true;
          reasons.push(`history[${i}]: ${leak.reason}`);
          continue;
        }
        const role = ["user", "assistant", "system"].includes(msg.role) ? msg.role : "user";
        const res = sanitizeText(msg.content || "", {
          vault,
          channel: Schema.CHANNELS.MODEL_CONTEXT,
          sourceKind: "conversation_history",
          authorizedRealNameIds: Array.from(runtimeCtx.authorizedRealNameRawIds),
          allowedCategories: runtimeCtx.allowedCategories,
          userConfirmed: callOpts?.userConfirmed === true,
          strictBlockUnreliable: callOpts?.strictBlockUnreliable === true
        });
        if (res.findings.length) {
          allFindings.push(...res.findings.map(f => Object.assign({ messageIndex: i, role }, f)));
        }
        if (res.decision === "block") {
          blocked = true;
          reasons.push(`history[${i}]: ${res.blockedReason}`);
        } else if (res.decision === "require_confirmation") {
          requiresConfirmation = true;
          reasons.push(`history[${i}]: ${res.confirmationReason}`);
        }
        sanitizedMessages.push({ role, content: res.redactedPreview });
      }

      const decision = blocked ? "block" : (requiresConfirmation ? "require_confirmation" : "allow");
      return {
        allowed: decision === "allow",
        decision,
        channel: Schema.CHANNELS.MODEL_CONTEXT,
        messages: decision === "allow" ? sanitizedMessages : null,
        redactedPreview: sanitizedMessages,
        findings: allFindings,
        requiresConfirmation: decision === "require_confirmation",
        reasons,
        unreliableAutoRedaction: allFindings.length > 0 || list.length > 0,
        disclaimers: [HONESTY_DISCLAIMER]
      };
    }

    function prepareModelContext(bundle, callOpts) {
      ensureFullEntityDictionary(callOpts?.queryCtx);
      const input = bundle || {};
      const runtimeCtx = buildRuntimeCtx(callOpts, Schema.CHANNELS.MODEL_CONTEXT);

      // 1. Hard check for accidental vault leakage anywhere in input
      const vaultLeak = detectVaultLeak(input);
      if (vaultLeak) {
        return {
          allowed: false,
          decision: "block",
          channel: Schema.CHANNELS.MODEL_CONTEXT,
          scope: runtimeCtx.scope,
          payload: null,
          blockedReasons: [vaultLeak.reason],
          findings: [{ category: "sensitive.vault_leak", path: vaultLeak.path, hardBlock: true }],
          requiresConfirmation: false,
          disclaimers: [HONESTY_DISCLAIMER]
        };
      }

      const findings = [];
      const reasons = [];
      let decision = "allow";
      const escalate = (next, reason) => {
        if (next === "block") {
          decision = "block";
          if (reason) reasons.push(reason);
        } else if (next === "require_confirmation" && decision !== "block") {
          decision = "require_confirmation";
          if (reason) reasons.push(reason);
        }
      };

      const outPayload = {
        channel: Schema.CHANNELS.MODEL_CONTEXT,
        scope: runtimeCtx.scope
      };

      // 2. Sanitize user prompt
      if (input.userMessage !== undefined && input.userMessage !== null) {
        const msgRes = sanitizeText(input.userMessage, {
          vault,
          channel: Schema.CHANNELS.MODEL_CONTEXT,
          sourceKind: "user_input",
          authorizedRealNameIds: Array.from(runtimeCtx.authorizedRealNameRawIds),
          allowedCategories: runtimeCtx.allowedCategories,
          userConfirmed: callOpts?.userConfirmed === true,
          strictBlockUnreliable: callOpts?.strictBlockUnreliable === true
        });
        findings.push(...msgRes.findings);
        if (msgRes.decision !== "allow") {
          escalate(msgRes.decision, msgRes.blockedReason || msgRes.confirmationReason);
        }
        outPayload.userMessage = msgRes.redactedPreview;
      }

      // 3. Sanitize conversation history
      if (Array.isArray(input.conversationHistory)) {
        const histRes = prepareConversationHistory(input.conversationHistory, callOpts);
        findings.push(...histRes.findings);
        if (histRes.decision !== "allow") {
          escalate(histRes.decision, histRes.reasons.join("；"));
        }
        outPayload.conversationHistory = histRes.redactedPreview;
      }

      // 4. Attach already-sanitized query results (verify channel & no raw leakage)
      if (Array.isArray(input.dataViews)) {
        const safeViews = [];
        for (let i = 0; i < input.dataViews.length; i++) {
          const view = input.dataViews[i];
          if (!view || typeof view !== "object" || view.channel !== Schema.CHANNELS.MODEL_CONTEXT || !view.audit) {
            escalate("block", `dataViews[${i}] 未经过 AI 隐私保护层脱敏处理，禁止直接出口`);
            continue;
          }
          if (view.decision === "block") {
            escalate("block", (view.blockedReasons || []).join("；") || `dataViews[${i}] 已被隐私策略阻断`);
            continue;
          }
          if (view.decision === "require_confirmation" && callOpts?.userConfirmed !== true) {
            escalate("require_confirmation", (view.confirmationReasons || []).join("；") || `dataViews[${i}] 需要人工确认`);
            safeViews.push({ scope: view.scope, data: view.confirmationPreview, meta: view.meta });
            continue;
          }
          safeViews.push({ scope: view.scope, data: view.data, meta: view.meta });
        }
        outPayload.dataViews = safeViews;
      }

      // 5. Sanitize error messages / logs if attached
      if (Array.isArray(input.errors)) {
        outPayload.errors = input.errors.map(e => sanitizeError(e, { vault }).message);
      }
      if (Array.isArray(input.logs)) {
        outPayload.logs = input.logs.map(l => sanitizeLog(l, { vault }).entry);
      }

      return {
        allowed: decision === "allow",
        decision,
        channel: Schema.CHANNELS.MODEL_CONTEXT,
        scope: runtimeCtx.scope,
        payload: decision === "allow" ? outPayload : null,
        redactedPreview: decision === "require_confirmation" ? outPayload : null,
        findings,
        requiresConfirmation: decision === "require_confirmation",
        blockedReasons: decision === "block" ? reasons : [],
        confirmationReasons: decision === "require_confirmation" ? reasons : [],
        disclaimers: [HONESTY_DISCLAIMER]
      };
    }

    /* ---------------- Independent Web Search Egress Gate ---------------- */

    /**
     * Strictly independent egress gate for external web search queries.
     * NEVER inherits grants or scope from MODEL_CONTEXT!
     */
    function prepareSearchQuery(request, callOpts) {
      ensureFullEntityDictionary(callOpts?.queryCtx);
      const req = typeof request === "string" ? { query: request } : (request || {});
      const rawQuery = String(req.query ?? "").trim();

      if (!searchPolicy.enabled && callOpts?.searchGrants?.enabled !== true) {
        return {
          allowed: false,
          decision: "block",
          channel: Schema.CHANNELS.WEB_SEARCH,
          sanitizedQuery: null,
          blockedReasons: ["外部联网搜索出口当前处于禁用状态"],
          findings: [],
          requiresConfirmation: false
        };
      }

      if (!rawQuery) {
        return {
          allowed: false,
          decision: "block",
          channel: Schema.CHANNELS.WEB_SEARCH,
          sanitizedQuery: null,
          blockedReasons: ["搜索查询内容为空"],
          findings: [],
          requiresConfirmation: false
        };
      }

      const leak = detectVaultLeak(req);
      if (leak) {
        return {
          allowed: false,
          decision: "block",
          channel: Schema.CHANNELS.WEB_SEARCH,
          sanitizedQuery: null,
          blockedReasons: [leak.reason],
          findings: [{ category: "sensitive.vault_leak", hardBlock: true }],
          requiresConfirmation: false
        };
      }

      // IMPORTANT: ONLY read search-specific grants! Completely ignore modelPolicy.grants and callOpts.grants!
      const searchGrantIds = []
        .concat(searchPolicy.authorizedRealNameIds || [])
        .concat(Array.isArray(req.searchGrants?.authorizedRealNameIds) ? req.searchGrants.authorizedRealNameIds : [])
        .concat(Array.isArray(callOpts?.searchGrants?.authorizedRealNameIds) ? callOpts.searchGrants.authorizedRealNameIds : []);

      const authorizedSearchRawIds = resolveAuthorizedRawIds(vault, searchGrantIds);

      const inspection = inspectText(rawQuery, {
        vault,
        channel: Schema.CHANNELS.WEB_SEARCH,
        sourceKind: "search_query",
        authorizedRealNameIds: Array.from(authorizedSearchRawIds)
      });

      const blockedReasons = [];
      for (const f of inspection.findings) {
        if (f.kind === "anonymous_alias") {
          blockedReasons.push(`搜索词包含内部匿名代号「${f.matched}」，禁止向外部搜索服务发送内部标识`);
        } else if (f.source === "vault_dictionary") {
          blockedReasons.push(`搜索词包含未获联网搜索授权的内部实体或数据（类别：${f.category}），即使模型上下文可见也不得直接发送给搜索服务`);
        } else if (f.category === "commercial.cost" || f.category === "commercial.volume") {
          blockedReasons.push(`搜索词包含内部商业敏感指标（类别：${f.category}），禁止发送给外部搜索服务`);
        } else if (f.category === "sensitive.contact" || f.category === "sensitive.address" || f.category === "sensitive.document_number" || f.category === "sensitive.identifier" || f.category === "sensitive.credential") {
          blockedReasons.push(`搜索词包含高敏感隐私/单据/凭据信息（类别：${f.category}），已阻断`);
        } else if (f.category === "identity.unindexed_org") {
          blockedReasons.push(`搜索词包含未登记的企业/工厂名称，无法确认是否属于公开可检索主体`);
        }
      }

      // Hard block for any unauthorized internal entity, alias, commercial metric, PII, or credential
      if (inspection.hasHardBlock) {
        return {
          allowed: false,
          decision: "block",
          channel: Schema.CHANNELS.WEB_SEARCH,
          sanitizedQuery: null,
          blockedReasons: Array.from(new Set(blockedReasons)),
          findings: inspection.findings,
          authorizedMatches: inspection.authorizedMatches.map(m => ({ alias: m.alias, category: m.category })),
          requiresConfirmation: false,
          disclaimers: [HONESTY_DISCLAIMER]
        };
      }

      // Unindexed org names or ambiguous hits -> require human confirmation (hard-blocked items already returned above)
      if (inspection.findings.length > 0) {
        if (callOpts?.userConfirmed === true) {
          return {
            allowed: true,
            decision: "allow",
            channel: Schema.CHANNELS.WEB_SEARCH,
            sanitizedQuery: rawQuery,
            blockedReasons: [],
            findings: inspection.findings,
            authorizedMatches: inspection.authorizedMatches.map(m => ({ alias: m.alias, category: m.category })),
            requiresConfirmation: false,
            disclaimers: [HONESTY_DISCLAIMER]
          };
        }
        return {
          allowed: false,
          decision: "require_confirmation",
          channel: Schema.CHANNELS.WEB_SEARCH,
          sanitizedQuery: null,
          pendingQuery: rawQuery,
          blockedReasons: [],
          confirmationReasons: Array.from(new Set(blockedReasons)),
          findings: inspection.findings,
          authorizedMatches: inspection.authorizedMatches.map(m => ({ alias: m.alias, category: m.category })),
          requiresConfirmation: true,
          disclaimers: [HONESTY_DISCLAIMER]
        };
      }

      return {
        allowed: true,
        decision: "allow",
        channel: Schema.CHANNELS.WEB_SEARCH,
        sanitizedQuery: rawQuery,
        blockedReasons: [],
        findings: [],
        authorizedMatches: inspection.authorizedMatches.map(m => ({ alias: m.alias, category: m.category })),
        requiresConfirmation: false,
        disclaimers: []
      };
    }

    /* ---------------- Local Rehydration ---------------- */

    function rehydrateResponse(response, rehydrateOpts) {
      if (typeof response === "string") {
        return vault.rehydrateText(response, rehydrateOpts);
      }
      return vault.rehydrateStructured(response, rehydrateOpts);
    }

    return Object.freeze({
      PRIVACY_VERSION,
      // Read-only sanitized business data queries (MODEL_CONTEXT)
      listPartitions,
      queryBomEntities,
      getBomDetail,
      querySales,
      getCrossModuleFactoryView,
      simulateSalesActions,
      sanitizeBusinessPayload,
      // Full egress gates
      prepareModelContext,
      prepareConversationHistory,
      prepareSearchQuery,
      // Text, error & log guards
      inspectText: (text, opts) => {
        ensureFullEntityDictionary(opts?.queryCtx);
        return inspectText(text, Object.assign({ vault }, opts));
      },
      sanitizeText: (text, opts) => {
        ensureFullEntityDictionary(opts?.queryCtx);
        return sanitizeText(text, Object.assign({ vault }, opts));
      },
      sanitizeError: (err, opts) => {
        ensureFullEntityDictionary(opts?.queryCtx);
        return sanitizeError(err, Object.assign({ vault }, opts));
      },
      sanitizeLog: (entry, opts) => {
        ensureFullEntityDictionary(opts?.queryCtx);
        return sanitizeLog(entry, Object.assign({ vault }, opts));
      },
      // Local rehydration & local-only vault helpers
      rehydrateResponse,
      resolveLocalAlias: (alias) => vault.resolveAlias(alias),
      translateInputId: (expectedTypes, idOrAlias) => {
        ensureManifestIndexed();
        return vault.translateInputId(expectedTypes, idOrAlias);
      },
      anonymizeId: (type, rawId, info) => vault.getOrCreateAlias(type, rawId, info),
      anonymizeTargetId: (rawId, preferredTypes) => vault.resolveRawTargetAlias(rawId, preferredTypes),
      registerCrossFactoryLink: (bf, sn) => vault.registerCrossFactoryLink(bf, sn),
      ensureManifestIndexed,
      getPolicySnapshot: () => ({
        scope: modelPolicy.scope,
        grants: Object.assign({}, modelPolicy.grants)
      }),
      getVaultStats: () => vault.getStats(),
      invalidateIndex,
      indexWorkspace: (overrideQueryCtx) => ensureFullEntityDictionary(overrideQueryCtx, true)
    });
  }

  const SCAIPrivacy = Object.freeze({
    PRIVACY_VERSION,
    HONESTY_DISCLAIMER,
    createContext,
    inspectText,
    sanitizeText,
    sanitizeError,
    sanitizeLog,
    detectVaultLeak
  });

  global.SCAIPrivacy = SCAIPrivacy;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIPrivacy;
  }
})(typeof window !== "undefined" ? window : globalThis);

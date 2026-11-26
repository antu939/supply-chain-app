(function (global) {
  "use strict";

  const AUDIT_VERSION = 1;
  const AUDIT_STORAGE_KEY = "sc-ai-audit-v1";
  const AUDIT_ARCHIVE_PREFIX = "sc-ai-audit-archive-v";
  const DEFAULT_ACTIVE_VOUCHER_LIMIT = 300;
  const MAX_EVIDENCE = 300;

  function defaultStorage() {
    return typeof localStorage !== "undefined" ? localStorage : null;
  }

  function genId(prefix) {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${ts}_${rand}`;
  }

  function maskSecretsOnly(text) {
    if (typeof text !== "string" || !text) return String(text ?? "");
    return text
      .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/gi, "[REDACTED_SECRET]")
      .replace(/\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd)\s*[:=]\s*["']?[^\s"',;]{4,}["']?/gi, "[REDACTED_CREDENTIAL]")
      .replace(/\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[REDACTED_ID_CARD]");
  }

  function cloneSafe(val) {
    return val === undefined ? null : JSON.parse(JSON.stringify(val));
  }

  function emptyStoreDoc() {
    return {
      format: "sc-ai-audit",
      version: AUDIT_VERSION,
      localOnly: true,
      neverSendToExternalModel: true,
      mutationVouchers: [],
      evidenceRecords: [],
      archives: [] // [{ key, count, oldestTimestamp, newestTimestamp, archivedAt }]
    };
  }

  function makeAuditError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  /**
   * Create a reliable local-only persistent Audit & Evidence Store.
   * - Stored under `sc-ai-audit-v1`, strictly separate from chat history (`sc-ai-chat-v1`).
   * - Never ignores storage write failures (throws AUDIT_PERSIST_FAILED and rolls back in-memory cache).
   * - Never silently deletes official mutation vouchers beyond active limit; archives overflow into dedicated keys.
   */
  function createAuditStore(options) {
    const opts = options || {};
    const storage = opts.storage !== undefined ? opts.storage : defaultStorage();
    const activeVoucherLimit = Math.max(10, Math.min(1000, Number(opts.activeVoucherLimit) || DEFAULT_ACTIVE_VOUCHER_LIMIT));
    let cache = null;

    function load() {
      if (cache) return cache;
      if (storage) {
        try {
          const raw = storage.getItem(AUDIT_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.format === "sc-ai-audit") {
              cache = {
                format: "sc-ai-audit",
                version: AUDIT_VERSION,
                localOnly: true,
                neverSendToExternalModel: true,
                mutationVouchers: Array.isArray(parsed.mutationVouchers) ? parsed.mutationVouchers : [],
                evidenceRecords: Array.isArray(parsed.evidenceRecords) ? parsed.evidenceRecords : [],
                archives: Array.isArray(parsed.archives) ? parsed.archives : []
              };
              return cache;
            }
          }
        } catch (_) {
          // Do not overwrite corrupted storage until explicit write
        }
      }
      cache = emptyStoreDoc();
      return cache;
    }

    /**
     * Strict write verification: NEVER swallows storage write failures.
     */
    function persistStrict(doc) {
      if (!storage) {
        cache = doc;
        return true;
      }
      const serialized = JSON.stringify(doc);
      try {
        storage.setItem(AUDIT_STORAGE_KEY, serialized);
      } catch (err) {
        throw makeAuditError("AUDIT_PERSIST_FAILED", `审计存储写入失败：${err?.message || String(err)}`);
      }
      // Verify readback when getItem is available
      try {
        const readBack = storage.getItem(AUDIT_STORAGE_KEY);
        if (readBack !== serialized) {
          throw makeAuditError("AUDIT_PERSIST_FAILED", "审计存储写入校验失败：读回内容不一致");
        }
      } catch (err) {
        if (err && err.code === "AUDIT_PERSIST_FAILED") throw err;
        throw makeAuditError("AUDIT_PERSIST_FAILED", `审计存储校验异常：${err?.message || String(err)}`);
      }
      cache = doc;
      return true;
    }

    /**
     * Archive overflow mutation vouchers instead of silently deleting them.
     */
    function archiveOverflowVouchers(doc) {
      if (doc.mutationVouchers.length <= activeVoucherLimit) return null;
      const keep = doc.mutationVouchers.slice(0, activeVoucherLimit);
      const overflow = doc.mutationVouchers.slice(activeVoucherLimit);
      const nextSeq = (doc.archives?.length || 0) + 1;
      const archiveKey = `${AUDIT_ARCHIVE_PREFIX}${nextSeq}`;
      const archivePayload = {
        format: "sc-ai-audit-archive",
        version: AUDIT_VERSION,
        localOnly: true,
        neverSendToExternalModel: true,
        archiveKey,
        archivedAt: Date.now(),
        count: overflow.length,
        vouchers: overflow
      };

      if (storage) {
        const serializedArchive = JSON.stringify(archivePayload);
        try {
          storage.setItem(archiveKey, serializedArchive);
          if (storage.getItem(archiveKey) !== serializedArchive) {
            throw makeAuditError("AUDIT_ARCHIVE_FAILED", `归档键 ${archiveKey} 写入校验失败`);
          }
        } catch (err) {
          throw makeAuditError("AUDIT_PERSIST_FAILED", `历史修改凭证归档失败（拒绝静默删除）：${err?.message || String(err)}`);
        }
      }

      const timestamps = overflow.map(v => v.timestamp || 0).filter(Boolean);
      doc.archives = Array.isArray(doc.archives) ? doc.archives.slice() : [];
      doc.archives.push({
        key: archiveKey,
        count: overflow.length,
        oldestTimestamp: timestamps.length ? Math.min(...timestamps) : null,
        newestTimestamp: timestamps.length ? Math.max(...timestamps) : null,
        archivedAt: archivePayload.archivedAt
      });
      doc.mutationVouchers = keep;
      return archiveKey;
    }

    /**
     * Record a system-generated business mutation voucher AFTER actual execution succeeds.
     * Throws AUDIT_PERSIST_FAILED if storage write or archive fails (never silently succeeds!).
     */
    function recordMutationVoucher(input) {
      if (!input || typeof input !== "object") {
        throw makeAuditError("INVALID_VOUCHER", "无效的业务修改凭证输入");
      }
      const nextDoc = cloneSafe(load());
      const now = Date.now();
      const voucher = {
        voucherId: input.voucherId || genId("op"),
        idempotencyKey: input.idempotencyKey ? String(input.idempotencyKey) : null,
        localOnly: true,
        neverSendToExternalModel: true,
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        actor: {
          userLabel: maskSecretsOnly(input.actor?.userLabel || "local_user"),
          modelId: maskSecretsOnly(input.actor?.modelId || "unknown_model"),
          provider: maskSecretsOnly(input.actor?.provider || "unknown_provider")
        },
        userInstruction: maskSecretsOnly(String(input.userInstruction || "").slice(0, 600)),
        authorization: cloneSafe(input.authorization || null),
        target: {
          module: String(input.target?.module || ""),
          entityType: String(input.target?.entityType || ""),
          entityId: String(input.target?.entityId || ""),
          displayName: maskSecretsOnly(String(input.target?.displayName || ""))
        },
        action: {
          type: String(input.action?.type || ""),
          payload: cloneSafe(input.action?.payload || {})
        },
        before: cloneSafe(input.before || null),
        after: cloneSafe(input.after || null),
        diff: Array.isArray(input.diff) ? cloneSafe(input.diff) : [],
        validation: cloneSafe(input.validation || { ok: true, errors: [] }),
        preview: cloneSafe(input.preview || null),
        execution: cloneSafe(input.execution || { ok: true }),
        dataVersion: cloneSafe(input.dataVersion || null),
        businessImpact: cloneSafe(input.businessImpact || null),
        undoable: Boolean(input.undoable),
        undoSpec: input.undoSpec ? cloneSafe(input.undoSpec) : null,
        undoneAt: null,
        undoVoucherId: null,
        revertsVoucherId: input.revertsVoucherId || null
      };

      nextDoc.mutationVouchers.unshift(voucher);
      let createdArchiveKey = null;
      try {
        createdArchiveKey = archiveOverflowVouchers(nextDoc);
        persistStrict(nextDoc);
      } catch (err) {
        // Best-effort cleanup of orphan archive key if main doc write failed
        if (createdArchiveKey && storage && typeof storage.removeItem === "function") {
          try { storage.removeItem(createdArchiveKey); } catch (_) {}
        }
        throw err;
      }
      return cloneSafe(voucher);
    }

    function markVoucherUndone(voucherId, undoVoucherId) {
      const nextDoc = cloneSafe(load());
      const target = nextDoc.mutationVouchers.find(v => v.voucherId === voucherId);
      if (!target) return false;
      target.undoneAt = Date.now();
      target.undoVoucherId = undoVoucherId;
      target.undoable = false;
      persistStrict(nextDoc);
      return true;
    }

    function findVoucherByIdempotencyKey(idempotencyKey) {
      if (!idempotencyKey) return null;
      const key = String(idempotencyKey);
      const doc = load();
      const hit = doc.mutationVouchers.find(v => v.idempotencyKey === key);
      if (hit) return cloneSafe(hit);
      if (storage && Array.isArray(doc.archives)) {
        for (const arch of doc.archives) {
          try {
            const raw = storage.getItem(arch.key);
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const found = (parsed.vouchers || []).find(v => v.idempotencyKey === key);
            if (found) return cloneSafe(found);
          } catch (_) {}
        }
      }
      return null;
    }

    function recordEvidence(input) {
      if (!input || typeof input !== "object") {
        throw makeAuditError("INVALID_EVIDENCE", "无效的决策/研究留证输入");
      }
      const nextDoc = cloneSafe(load());
      const now = Date.now();
      const cleanSources = Array.isArray(input.externalSources)
        ? input.externalSources
            .filter(s => s && typeof s.url === "string" && s.url.trim())
            .map(s => ({
              title: maskSecretsOnly(String(s.title || "")),
              url: String(s.url).trim(),
              verifiedAt: s.verifiedAt || new Date(now).toISOString(),
              excerpt: maskSecretsOnly(String(s.excerpt || "").slice(0, 500))
            }))
        : [];

      const record = {
        evidenceId: input.evidenceId || genId("evd"),
        localOnly: true,
        neverSendToExternalModel: true,
        timestamp: now,
        isoTime: new Date(now).toISOString(),
        kind: input.kind === "web_research" ? "web_research" : "decision",
        modelId: maskSecretsOnly(input.modelId || ""),
        userQuery: maskSecretsOnly(String(input.userQuery || "").slice(0, 400)),
        internalDataRefs: Array.isArray(input.internalDataRefs) ? cloneSafe(input.internalDataRefs) : [],
        dataVersion: cloneSafe(input.dataVersion || null),
        calculationBasis: cloneSafe(input.calculationBasis || null),
        externalSources: cleanSources,
        epistemicLabels: {
          facts: Array.isArray(input.epistemicLabels?.facts) ? input.epistemicLabels.facts.map(maskSecretsOnly) : [],
          projections: Array.isArray(input.epistemicLabels?.projections) ? input.epistemicLabels.projections.map(maskSecretsOnly) : [],
          inferences: Array.isArray(input.epistemicLabels?.inferences) ? input.epistemicLabels.inferences.map(maskSecretsOnly) : [],
          unknowns: Array.isArray(input.epistemicLabels?.unknowns) ? input.epistemicLabels.unknowns.map(maskSecretsOnly) : []
        }
      };

      nextDoc.evidenceRecords.unshift(record);
      if (nextDoc.evidenceRecords.length > MAX_EVIDENCE) {
        nextDoc.evidenceRecords = nextDoc.evidenceRecords.slice(0, MAX_EVIDENCE);
      }
      persistStrict(nextDoc);
      return cloneSafe(record);
    }

    function listMutationVouchers(filter) {
      const doc = load();
      const f = filter || {};
      let list = doc.mutationVouchers.slice();
      if (f.module) list = list.filter(v => v.target?.module === f.module);
      if (f.entityId) list = list.filter(v => v.target?.entityId === f.entityId);
      const limit = Math.max(1, Math.min(500, Number(f.limit) || 50));
      return cloneSafe(list.slice(0, limit));
    }

    function listArchives() {
      const doc = load();
      return cloneSafe(doc.archives || []);
    }

    function listArchivedVouchers(archiveKey) {
      if (!storage || !archiveKey) return [];
      try {
        const raw = storage.getItem(String(archiveKey));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.vouchers) ? cloneSafe(parsed.vouchers) : [];
      } catch (_) {
        return [];
      }
    }

    function getMutationVoucher(voucherId) {
      const doc = load();
      const found = doc.mutationVouchers.find(v => v.voucherId === voucherId);
      if (found) return cloneSafe(found);
      if (storage && Array.isArray(doc.archives)) {
        for (const arch of doc.archives) {
          const archived = listArchivedVouchers(arch.key).find(v => v.voucherId === voucherId);
          if (archived) return archived;
        }
      }
      return null;
    }

    function listEvidenceRecords(filter) {
      const doc = load();
      const f = filter || {};
      let list = doc.evidenceRecords.slice();
      if (f.kind) list = list.filter(e => e.kind === f.kind);
      const limit = Math.max(1, Math.min(200, Number(f.limit) || 50));
      return cloneSafe(list.slice(0, limit));
    }

    function getCounts() {
      const doc = load();
      const archivedVouchers = (doc.archives || []).reduce((s, a) => s + (Number(a.count) || 0), 0);
      return {
        mutationVouchers: doc.mutationVouchers.length,
        archivedMutationVouchers: archivedVouchers,
        totalMutationVouchers: doc.mutationVouchers.length + archivedVouchers,
        archiveBuckets: (doc.archives || []).length,
        evidenceRecords: doc.evidenceRecords.length
      };
    }

    return Object.freeze({
      AUDIT_VERSION,
      AUDIT_STORAGE_KEY,
      AUDIT_ARCHIVE_PREFIX,
      recordMutationVoucher,
      markVoucherUndone,
      findVoucherByIdempotencyKey,
      recordEvidence,
      listMutationVouchers,
      listArchives,
      listArchivedVouchers,
      getMutationVoucher,
      listEvidenceRecords,
      getCounts,
      toJSON: () => "[BLOCKED:LOCAL_AUDIT_STORE_NEVER_SEND_TO_MODEL]"
    });
  }

  const SCAIAudit = Object.freeze({
    AUDIT_VERSION,
    AUDIT_STORAGE_KEY,
    AUDIT_ARCHIVE_PREFIX,
    DEFAULT_ACTIVE_VOUCHER_LIMIT,
    createAuditStore,
    maskSecretsOnly
  });

  global.SCAIAudit = SCAIAudit;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIAudit;
  }
})(typeof window !== "undefined" ? window : globalThis);

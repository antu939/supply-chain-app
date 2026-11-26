(function (global) {
  "use strict";

  const REGISTRY_VERSION = "1.0";
  const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;
  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  function own(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function deepClone(val) {
    return val === undefined ? undefined : JSON.parse(JSON.stringify(val));
  }

  /**
   * Strict JSON Schema validator (Draft-7 subset compatible with Function Calling / Tool Calling).
   * Rejects unknown properties when additionalProperties === false, non-finite numbers,
   * prototype-pollution keys, and out-of-range/invalid values.
   */
  function validateAgainstSchema(schema, value, path) {
    const errors = [];
    const curPath = path || "$";

    if (!schema || typeof schema !== "object") return errors;

    if (value === null || value === undefined) {
      errors.push(`${curPath}: 值不能为空`);
      return errors;
    }

    const expectedType = schema.type;
    if (expectedType === "object") {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${curPath}: 必须是对象 (object)`);
        return errors;
      }
      const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      const keys = Object.keys(value);

      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) {
          errors.push(`${curPath}.${k}: 禁止使用保留键名`);
          continue;
        }
        if (schema.additionalProperties === false && !own(props, k)) {
          errors.push(`${curPath}.${k}: 不允许的未定义参数`);
        }
      }

      if (Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          if (!own(value, reqKey) || value[reqKey] === undefined || value[reqKey] === null) {
            errors.push(`${curPath}.${reqKey}: 缺少必填参数`);
          }
        }
      }

      for (const [k, propSchema] of Object.entries(props)) {
        if (!own(value, k) || value[k] === undefined) continue;
        if (value[k] === null && propSchema.nullable === true) continue;
        errors.push(...validateAgainstSchema(propSchema, value[k], `${curPath}.${k}`));
      }
      return errors;
    }

    if (expectedType === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${curPath}: 必须是数组 (array)`);
        return errors;
      }
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        errors.push(`${curPath}: 数组元素数量不能少于 ${schema.minItems}`);
      }
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
        errors.push(`${curPath}: 数组元素数量不能超过 ${schema.maxItems}`);
      }
      if (schema.uniqueItems === true) {
        const seen = new Set(value.map(v => JSON.stringify(v)));
        if (seen.size !== value.length) {
          errors.push(`${curPath}: 数组元素不能重复`);
        }
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateAgainstSchema(schema.items, value[i], `${curPath}[${i}]`));
        }
      }
      return errors;
    }

    if (expectedType === "string") {
      if (typeof value !== "string") {
        errors.push(`${curPath}: 必须是字符串 (string)`);
        return errors;
      }
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        errors.push(`${curPath}: 字符串长度不能小于 ${schema.minLength}`);
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        errors.push(`${curPath}: 字符串长度不能超过 ${schema.maxLength}`);
      }
      if (typeof schema.pattern === "string") {
        const re = new RegExp(schema.pattern);
        if (!re.test(value)) {
          errors.push(`${curPath}: 字符串格式不符合要求 (${schema.pattern})`);
        }
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${curPath}: 取值必须是 [${schema.enum.join(", ")}] 之一`);
      }
      return errors;
    }

    if (expectedType === "integer" || expectedType === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${curPath}: 必须是有限数字 (${expectedType})`);
        return errors;
      }
      if (expectedType === "integer" && !Number.isInteger(value)) {
        errors.push(`${curPath}: 必须是整数 (integer)`);
      }
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        errors.push(`${curPath}: 数值不能小于 ${schema.minimum}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        errors.push(`${curPath}: 数值不能大于 ${schema.maximum}`);
      }
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push(`${curPath}: 取值必须是 [${schema.enum.join(", ")}] 之一`);
      }
      return errors;
    }

    if (expectedType === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`${curPath}: 必须是布尔值 (boolean)`);
      }
      return errors;
    }

    return errors;
  }

  /**
   * Create a vendor-agnostic, whitelist-only Tool Registry.
   * Only explicitly registered, read-only tools (in Stage 2) can be discovered or invoked.
   */
  function createRegistry(options) {
    const opts = options || {};
    const allowWriteTools = opts.allowWriteTools === true; // Stage 2 defaults strictly to false
    const tools = new Map();

    function register(def) {
      if (!def || typeof def !== "object") {
        throw new Error("工具定义必须是对象");
      }
      const name = String(def.name || "").trim();
      if (!TOOL_NAME_RE.test(name)) {
        throw new Error(`非法工具名称「${name}」：仅允许小写字母、数字与下划线（2~49 字符）`);
      }
      if (tools.has(name)) {
        throw new Error(`工具「${name}」已注册，禁止重复覆盖`);
      }
      if (typeof def.description !== "string" || !def.description.trim()) {
        throw new Error(`工具「${name}」缺少功能说明 description`);
      }
      if (!def.parameters || def.parameters.type !== "object") {
        throw new Error(`工具「${name}」缺少合法的 JSON Schema parameters 定义`);
      }
      if (typeof def.execute !== "function") {
        throw new Error(`工具「${name}」缺少执行函数 execute`);
      }
      const readOnly = def.readOnly !== false;
      if (!readOnly && !allowWriteTools) {
        throw new Error(`当前阶段禁止注册写入/修改类工具「${name}」`);
      }

      const record = Object.freeze({
        name,
        description: def.description.trim(),
        useCases: Array.isArray(def.useCases) ? Object.freeze(def.useCases.slice()) : Object.freeze([]),
        category: def.category || "general",
        readOnly,
        defaultScope: def.defaultScope || "relationship_only",
        allowedScopes: Array.isArray(def.allowedScopes) ? Object.freeze(def.allowedScopes.slice()) : null,
        requiredChannel: def.requiredChannel || "model_context",
        parameters: Object.freeze(deepClone(def.parameters)),
        returns: def.returns ? Object.freeze(deepClone(def.returns)) : null,
        validate: typeof def.validate === "function" ? def.validate : null,
        execute: def.execute
      });

      tools.set(name, record);
      return record;
    }

    function hasTool(name) {
      return typeof name === "string" && TOOL_NAME_RE.test(name) && tools.has(name);
    }

    function getTool(name) {
      if (!hasTool(name)) return null;
      return tools.get(name);
    }

    function listTools(filterOpts) {
      const f = filterOpts || {};
      const allowSet = Array.isArray(f.allowedTools) ? new Set(f.allowedTools) : null;
      const list = [];
      for (const tool of tools.values()) {
        if (allowSet && !allowSet.has(tool.name)) continue;
        if (f.category && tool.category !== f.category) continue;
        if (f.readOnlyOnly && !tool.readOnly) continue;
        list.push({
          name: tool.name,
          description: tool.description,
          useCases: tool.useCases.slice(),
          category: tool.category,
          readOnly: tool.readOnly,
          defaultScope: tool.defaultScope,
          allowedScopes: tool.allowedScopes ? tool.allowedScopes.slice() : null,
          requiredChannel: tool.requiredChannel,
          parameters: deepClone(tool.parameters),
          returns: tool.returns ? deepClone(tool.returns) : null
        });
      }
      return list;
    }

    /**
     * Export provider-neutral or provider-specific Function Calling / Tool Calling schemas.
     * Supports: "standard" | "openai" | "gemini" | "anthropic"
     */
    function exportToolDefinitions(format, filterOpts) {
      const fmt = format || "standard";
      const list = listTools(filterOpts);
      return list.map(t => {
        if (fmt === "openai") {
          return {
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }
          };
        }
        if (fmt === "anthropic") {
          return {
            name: t.name,
            description: t.description,
            input_schema: t.parameters
          };
        }
        if (fmt === "gemini") {
          return {
            name: t.name,
            description: t.description,
            parameters: t.parameters
          };
        }
        return {
          name: t.name,
          description: t.description,
          readOnly: t.readOnly,
          defaultScope: t.defaultScope,
          parameters: t.parameters,
          returns: t.returns
        };
      });
    }

    function validateToolArgs(name, args) {
      const tool = getTool(name);
      if (!tool) {
        return { ok: false, errors: [`未知工具「${String(name)}」`] };
      }
      const input = args === undefined ? {} : args;
      const errors = validateAgainstSchema(tool.parameters, input, "arguments");
      if (errors.length === 0 && tool.validate) {
        const extraErrors = tool.validate(input);
        if (Array.isArray(extraErrors) && extraErrors.length > 0) {
          errors.push(...extraErrors);
        }
      }
      return { ok: errors.length === 0, errors };
    }

    return Object.freeze({
      REGISTRY_VERSION,
      register,
      hasTool,
      getTool,
      listTools,
      exportToolDefinitions,
      validateToolArgs,
      size: () => tools.size
    });
  }

  const SCAIToolRegistry = Object.freeze({
    REGISTRY_VERSION,
    TOOL_NAME_RE,
    validateAgainstSchema,
    createRegistry
  });

  global.SCAIToolRegistry = SCAIToolRegistry;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SCAIToolRegistry;
  }
})(typeof window !== "undefined" ? window : globalThis);

/**
 * The schemas in lib/llm/local.ts are written for node-llama-cpp's grammar, where an
 * object's properties are all required and no others are allowed. The MLX engine holds
 * replies to real JSON Schema instead, where properties are optional and extras allowed
 * unless the schema says otherwise — so a model could leave out a question's rubric, or
 * make up fields of its own. This spells out what the grammar assumes.
 */
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" || key === "$defs" || key === "defs") {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, strictSchema(v)]));
    } else if (["items", "prefixItems", "oneOf", "anyOf", "allOf", "additionalProperties"].includes(key)) {
      out[key] = strictSchema(value);
    } else {
      out[key] = value;
    }
  }
  if (out.properties && typeof out.properties === "object") {
    out.required = Object.keys(out.properties);
    if (!("additionalProperties" in out)) out.additionalProperties = false;
  }
  return out;
}

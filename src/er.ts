import type { CompatibilityMode } from "./config.js";
import type { TableRelationship } from "./db.js";

export interface ErColumn {
  name: string;
  type?: string;
  primaryKey?: boolean;
  nullable?: boolean;
}

export interface ErEntity {
  schema?: string;
  table: string;
  columns: ErColumn[];
}

export interface ErDiagram {
  mode: CompatibilityMode;
  entities: ErEntity[];
  relationships: TableRelationship[];
  mermaid: string;
}

export function buildErDiagram(
  mode: CompatibilityMode,
  entities: ErEntity[],
  relationships: TableRelationship[]
): ErDiagram {
  return {
    mode,
    entities,
    relationships,
    mermaid: renderMermaidEr(entities, relationships)
  };
}

function renderMermaidEr(entities: ErEntity[], relationships: TableRelationship[]): string {
  const lines = ["erDiagram"];
  const entityIds = new Map<string, string>();
  for (const entity of entities) {
    const id = entityId(entity.schema, entity.table);
    entityIds.set(entityKey(entity.schema, entity.table), id);
    lines.push(`  ${id} {`);
    const columns = entity.columns.slice(0, 50);
    if (columns.length === 0) {
      lines.push("    string metadata");
    } else {
      for (const column of columns) {
        const flags = [column.primaryKey ? "PK" : "", column.nullable === false ? "NOT_NULL" : ""].filter(
          Boolean
        );
        lines.push(
          `    ${mermaidType(column.type)} ${mermaidName(column.name)}${flags.length ? ` ${flags.join(" ")}` : ""}`
        );
      }
    }
    lines.push("  }");
  }

  for (const relationship of relationships) {
    const source = entityIds.get(entityKey(relationship.sourceSchema, relationship.sourceTable));
    const target = entityIds.get(entityKey(relationship.targetSchema, relationship.targetTable));
    if (!source || !target) {
      continue;
    }
    const label = relationship.constraintName ?? relationship.relationType;
    lines.push(`  ${target} ||--o{ ${source} : "${mermaidLabel(label)}"`);
  }

  return lines.join("\n");
}

function entityKey(schema: string | undefined, table: string): string {
  return `${schema ?? ""}.${table}`.toLowerCase();
}

function entityId(schema: string | undefined, table: string): string {
  return mermaidName(schema ? `${schema}_${table}` : table);
}

function mermaidName(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");
  return normalized || "entity";
}

function mermaidType(value: string | undefined): string {
  if (!value) {
    return "string";
  }
  return mermaidName(value.split(/\s+/)[0] ?? "string");
}

function mermaidLabel(value: string): string {
  return value.replace(/["\\]/g, "").slice(0, 80);
}

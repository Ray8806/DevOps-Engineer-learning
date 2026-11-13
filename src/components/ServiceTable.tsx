"use client";

import Link from "next/link";
import { useState } from "react";

export interface ServiceRow {
  unitId: string;
  concept: string;
  stage: string;
  aws: string[];
  gcp: string[];
}

export function ServiceTable({ rows }: { rows: ServiceRow[] }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? rows.filter((r) => [r.concept, ...r.aws, ...r.gcp].some((text) => text.toLowerCase().includes(needle)))
    : rows;

  return (
    <div>
      <label htmlFor="service-search" className="text-sm font-semibold">
        搜尋觀念或服務名稱
      </label>
      <input
        id="service-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="例如 S3、Cloud Storage、儲存"
        className="mt-2 block w-full max-w-md rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
      />
      <p className="mt-2 text-sm text-muted" role="status">
        {needle ? `符合 ${visible.length} 項，共 ${rows.length} 項` : `共 ${rows.length} 項`}
      </p>

      {visible.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-muted">
          找不到符合「{query.trim()}」的項目。
        </p>
      ) : (
        <div className="table-scroll lesson mt-4 rounded-xl border border-border bg-surface px-2">
          <table>
            <thead>
              <tr>
                <th scope="col">觀念</th>
                <th scope="col" className="!text-aws">AWS</th>
                <th scope="col" className="!text-gcp">GCP</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.unitId}>
                  <th scope="row" className="!text-text">
                    <Link href={`/units/${row.unitId}`}>{row.concept}</Link>
                    <span className="block text-xs font-normal text-muted">{row.stage}</span>
                  </th>
                  <td>{row.aws.length ? row.aws.join("、") : <span className="text-muted">—</span>}</td>
                  <td>{row.gcp.length ? row.gcp.join("、") : <span className="text-muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

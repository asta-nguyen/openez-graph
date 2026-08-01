import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@openez-graph/ui";
import { api } from "../lib/api";

export const Route = createFileRoute("/changelog")({
  component: ChangelogPage,
});

function ChangelogPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["changelog"],
    queryFn: () => api.getChangelog(),
  });

  if (isLoading) {
    return (
      <div className="page">
        <h1>Changelog</h1>
        <p className="muted text-sm">Loading...</p>
      </div>
    );
  }

  if (error || !data?.content) {
    return (
      <div className="page">
        <h1>Changelog</h1>
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {error ? error.message : "No changelog found."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const sections = parseChangelog(data.content);

  return (
    <div className="page">
      <div className="mb-6">
        <h1>Changelog</h1>
        <p className="muted text-sm">Release history for OpenEZ Graph.</p>
      </div>

      <div className="flex flex-col gap-4">
        {sections.map((section) => (
          <Card key={section.version}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <CardTitle className="text-base font-mono">{section.version}</CardTitle>
                {section.date && (
                  <span className="text-xs text-muted-foreground">{section.date}</span>
                )}
                {section.summary && (
                  <span className="text-sm text-muted-foreground">{section.summary}</span>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-3">
                {section.groups.map((group) => (
                  <div key={group.label}>
                    <h4 className="text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
                      {group.label}
                    </h4>
                    <ul className="flex flex-col gap-1">
                      {group.items.map((item, i) => (
                        <li key={i} className="text-sm flex gap-2">
                          <span className="text-muted-foreground shrink-0">•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

interface ChangelogGroup {
  label: string;
  items: string[];
}

interface ChangelogSection {
  version: string;
  date?: string;
  summary?: string;
  groups: ChangelogGroup[];
}

function parseChangelog(content: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const headingRegex = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?(.*)$/gm;
  const groupLabels = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

  let match: RegExpExecArray | null;
  const positions: Array<{ version: string; date?: string; summary?: string; start: number }> = [];
  while ((match = headingRegex.exec(content)) !== null) {
    positions.push({
      version: match[1],
      date: match[2]?.trim() || undefined,
      summary: match[3]?.trim() || undefined,
      start: match.index + match[0].length,
    });
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? content.indexOf("## ", positions[i + 1].start - 200) : content.length;
    const body = content.slice(positions[i].start, end > positions[i].start ? end : content.length).trim();

    const groups: ChangelogGroup[] = [];
    const groupRegex = new RegExp(`^###\\s+(${groupLabels.join("|")})\\s*$`, "gm");
    let groupMatch: RegExpExecArray | null;
    const groupPositions: Array<{ label: string; start: number }> = [];

    while ((groupMatch = groupRegex.exec(body)) !== null) {
      groupPositions.push({ label: groupMatch[1], start: groupMatch.index + groupMatch[0].length });
    }

    if (groupPositions.length === 0) {
      const items = body.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.trim().slice(1).trim());
      if (items.length > 0) {
        groups.push({ label: "Changes", items });
      }
    } else {
      for (let j = 0; j < groupPositions.length; j++) {
        const groupEnd = j + 1 < groupPositions.length ? body.indexOf("### ", groupPositions[j + 1].start - 10) : body.length;
        const groupBody = body.slice(groupPositions[j].start, groupEnd > groupPositions[j].start ? groupEnd : body.length).trim();
        const items = groupBody.split("\n").filter((l) => l.trim().startsWith("-")).map((l) => l.trim().slice(1).trim());
        if (items.length > 0) {
          groups.push({ label: groupPositions[j].label, items });
        }
      }
    }

    sections.push({
      version: positions[i].version,
      date: positions[i].date,
      summary: positions[i].summary,
      groups,
    });
  }

  return sections;
}

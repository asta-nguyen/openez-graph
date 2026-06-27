import { useDeferredValue, useEffect, useState } from "react";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@openez-graph/ui";
import { ALL_VALUE } from "../../lib/constants";

interface DocumentsFiltersProps {
  currentSearch: string;
  currentKind: string;
  currentLanguage: string;
  kinds: string[];
  languages: string[];
  onFilterChange: (next: { search?: string; kind?: string; language?: string }) => void;
}

export function DocumentsFilters({
  currentSearch,
  currentKind,
  currentLanguage,
  kinds,
  languages,
  onFilterChange,
}: DocumentsFiltersProps) {
  const [searchInput, setSearchInput] = useState(currentSearch);
  const deferredSearch = useDeferredValue(searchInput);

  // Sync local input when the URL-driven value changes externally (e.g. back/forward).
  useEffect(() => {
    setSearchInput(currentSearch);
  }, [currentSearch]);

  // Debounce: push the deferred search value to the URL once it settles.
  useEffect(() => {
    if (deferredSearch !== currentSearch) {
      onFilterChange({ search: deferredSearch });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredSearch]);

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <Input
        type="text"
        placeholder="Search path..."
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        className="h-9 w-full max-w-xs"
      />
      <Select
        value={currentKind || ALL_VALUE}
        onValueChange={(value) => onFilterChange({ kind: value === ALL_VALUE ? "" : value })}
      >
        <SelectTrigger size="sm" className="w-[160px]" aria-label="Kind">
          <SelectValue placeholder="All kinds" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All kinds</SelectItem>
          {kinds.map((k) => (
            <SelectItem key={k} value={k}>
              {k}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={currentLanguage || ALL_VALUE}
        onValueChange={(value) => onFilterChange({ language: value === ALL_VALUE ? "" : value })}
      >
        <SelectTrigger size="sm" className="w-[160px]" aria-label="Language">
          <SelectValue placeholder="All languages" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All languages</SelectItem>
          {languages.map((l) => (
            <SelectItem key={l} value={l}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

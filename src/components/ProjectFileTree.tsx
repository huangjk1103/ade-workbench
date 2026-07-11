import {
  Atom,
  ChevronDown,
  ChevronRight,
  Dna,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  Hexagon,
  ListOrdered,
  Network,
  Presentation,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ProjectEntry } from "../types/domain";

const icons: Record<ProjectEntry["kind"], ReactNode> = {
  folder: <Folder size={14} />,
  markdown: <FileText size={14} />,
  text: <FileText size={14} />,
  image: <FileImage size={14} />,
  word: <FileText size={14} />,
  slides: <Presentation size={14} />,
  sheet: <FileSpreadsheet size={14} />,
  pdf: <FileText size={14} />,
  // Bioinformatics kinds — keep the icon family consistent (size 14) so the
  // row height stays aligned with the rest of the tree.
  sequence: <Dna size={14} />,
  annotation: <FileText size={14} />,
  feature: <ListOrdered size={14} />,
  variant: <Atom size={14} />,
  alignment: <GitFork size={14} />,
  structure: <Hexagon size={14} />,
  ontology: <Network size={14} />,
  binary: <File size={14} />,
};

function TreeRow({
  entry,
  depth,
  activePath,
  onOpen,
}: {
  entry: ProjectEntry;
  depth: number;
  activePath?: string;
  onOpen: (entry: ProjectEntry) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isFolder = entry.kind === "folder";
  return (
    <div>
      <button
        type="button"
        className={`tree-row tree-row--${entry.kind} ${activePath === entry.relativePath ? "is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => isFolder ? setExpanded((value) => !value) : onOpen(entry)}
        title={entry.relativePath}
      >
        <span className="tree-chevron">
          {isFolder ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </span>
        <span className="tree-icon">{isFolder && expanded ? <FolderOpen size={14} /> : icons[entry.kind]}</span>
        <span>{entry.name}</span>
      </button>
      {isFolder && expanded && entry.children.map((child) => (
        <TreeRow key={child.relativePath} entry={child} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function ProjectFileTree({
  entries,
  activePath,
  onOpen,
}: {
  entries: ProjectEntry[];
  activePath?: string;
  onOpen: (entry: ProjectEntry) => void;
}) {
  return (
    <div className="project-tree">
      {entries.map((entry) => <TreeRow key={entry.relativePath} entry={entry} depth={0} activePath={activePath} onOpen={onOpen} />)}
    </div>
  );
}
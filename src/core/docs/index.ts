export type { MemberKind, MemberDoc, ClassDoc, FileDoc, ProseMap } from './types';
export { slug, typeSlug, memberId, classAnchor, paramTypesOf } from './id';
export {
  DOC_VERSION,
  INDEX_FILE,
  MARKER_FILE,
  ANCHOR_RE,
  renderClassHeading,
  renderMember,
  renderFileHeader,
  renderFile,
  renderIndex,
  parseBlocks,
  type CallLink,
  type IndexEntry,
} from './markdown';
export {
  isGitRepo,
  baselineCommit,
  statusChanges,
  changedLineRanges,
  isTracked,
  listCsFiles,
  type GitChange,
} from './git';
export { decide, touchedSources, isDeletion, isUntracked, changedMemberIds, type SyncMode, type Decision } from './plan';
export { writeProse, type DocAiConfig, type ProseItem } from './writer';
export {
  DOCS_DIR_DEFAULT,
  markerPath,
  readMarker,
  writeMarker,
  mdRelPath,
  listDocFiles,
  classesIn,
  writeIndex,
  pruneEmptyDirs,
  type Marker,
} from './store';

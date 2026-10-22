export type { MemberKind, MemberDoc, ClassDoc, FileDoc, ProseMap } from './types';
export { slug, typeSlug, memberId, classAnchor, paramTypesOf } from './id';
export { bareName, typeOf, clampType, isTrivialProperty } from './naming';
export {
  DOC_VERSION,
  INDEX_FILE,
  MARKER_FILE,
  renderClassHeading,
  renderMember,
  renderFileHeader,
  renderFile,
  renderIndex,
  parseBlocks,
  hasProse,
  headingSlug,
  uniqueHeading,
  renderPropsTable,
  propsAnchor,
  type CallLink,
  type IndexEntry,
} from './markdown';
export { labelsFor, type DocLang, type DocLabels } from './labels';
export {
  isGitRepo,
  baselineCommit,
  headCommit,
  statusChanges,
  diffNameStatus,
  changedLineRanges,
  isTracked,
  isDirTracked,
  listCsFiles,
  type GitChange,
} from './git';
export {
  decide,
  touchedSources,
  isDeletion,
  isUntracked,
  changedMemberIds,
  type SyncMode,
  type Decision,
  type ReasonKey,
} from './plan';
export { writeProse, type DocAiConfig, type ProseItem, type ProseResult } from './writer';
export {
  DOCS_DIR_DEFAULT,
  markerPath,
  readMarker,
  writeMarker,
  mdRelPath,
  csRelFromMd,
  listDocFiles,
  classesIn,
  writeIndex,
  pruneEmptyDirs,
  type Marker,
} from './store';

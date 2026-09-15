/**
 * Public surface of the plugin's browser half: the component library the page
 * issues (KB-04 onwards) compose.
 *
 * One barrel, because callers import a control by name; the alternative —
 * importing each module path — makes a rename reach into every page.
 *
 * @module dsh-zvec-knowledge/client/components
 */

export { Icon, type IconName, type IconProps } from './Icon.tsx'
export { Spinner, type SpinnerProps, type SpinnerSize } from './Spinner.tsx'
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button.tsx'
export { IconButton, type IconButtonProps, type IconButtonSize } from './IconButton.tsx'
export { TextField, type TextFieldProps, type TextFieldVariant } from './TextField.tsx'
export { SearchField, type SearchFieldProps } from './SearchField.tsx'
export { Select, type SelectOption, type SelectProps } from './Select.tsx'
export { Switch, type SwitchProps } from './Switch.tsx'
export { Checkbox, Radio, type CheckboxProps, type RadioProps } from './Checkbox.tsx'
export {
  SegmentedControl,
  type SegmentOption,
  type SegmentedControlProps,
} from './SegmentedControl.tsx'
export { Tabs, type TabItem, type TabsProps } from './Tabs.tsx'
export { StatusPill, type StatusKind, type StatusPillProps } from './StatusPill.tsx'
export { Tag, type TagProps, type TagTone } from './Tag.tsx'
export { CountBadge, type CountBadgeProps } from './CountBadge.tsx'
export { ProgressBar, type ProgressBarProps } from './ProgressBar.tsx'
export { StatCard, type StatCardProps } from './StatCard.tsx'
export { StorageUsageCard, type StorageUsage, type StorageUsageCardProps } from './StorageUsageCard.tsx'
export { CollectionCard, type CollectionCardProps, type CollectionCardStats } from './CollectionCard.tsx'
export { EmptyState, type EmptyStateProps } from './EmptyState.tsx'
export { QuotaNotice, type QuotaNoticeProps, type QuotaStateView } from './QuotaNotice.tsx'
export { UploadDropzone, type UploadDropzoneProps } from './UploadDropzone.tsx'
export {
  DocumentRow, formatChunks, formatSize,
  type DocumentRowData, type DocumentRowProps, type TransferState,
} from './DocumentRow.tsx'
export { NumberField, type NumberFieldProps } from './NumberField.tsx'
export { StrategyEvidence, type StrategyEvidenceProps } from './StrategyEvidence.tsx'
export { CostEstimate, type CostEstimateProps } from './CostEstimate.tsx'
export {
  BuildPipeline, formatLogTime,
  type BuildPipelineProps, type LogLine, type StageId, type StageState, type StageView,
} from './BuildPipeline.tsx'

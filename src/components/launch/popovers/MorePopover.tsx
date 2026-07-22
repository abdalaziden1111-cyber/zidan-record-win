import {
	EyeIcon,
	EyeSlashIcon,
	FolderOpenIcon,
	TranslateIcon,
	VideoCameraIcon,
	ArrowClockwiseIcon,
	SunIcon,
	MoonIcon,
	DesktopIcon,
	MonitorIcon,
} from "@phosphor-icons/react";
import type { RecordingQuality } from "@/hooks/useScreenRecorder";
import type { ReactElement } from "react";
import { useI18n } from "@/contexts/I18nContext";
import { useScopedT } from "@/contexts/I18nContext";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppLocale } from "@/i18n/config";
import { SUPPORTED_LOCALES } from "@/i18n/config";
import styles from "../LaunchWindow.module.css";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import { DropdownItem, HudPopover } from "./PopoverScaffold";

const POPOVER_ID = "more";

const LOCALE_LABELS: Record<string, string> = {
	en: "English",
	es: "Español",
	fr: "Français",
	it: "Italiano",
	nl: "Nederlands",
	ko: "한국어",
	"pt-BR": "Português",
	"zh-CN": "簡體中文",
	"zh-TW": "繁體中文",
};

const QUALITY_LABELS: Record<RecordingQuality, string> = {
	"720p": "720p",
	"1080p": "1080p (Full HD)",
	"2k": "2K (1440p)",
	"3k": "3K (1620p)",
	"4k": "4K (2160p)",
};

export function MorePopover({
	trigger,
	supportsHudCaptureProtection,
	hideHudFromCapture,
	onToggleHudCaptureProtection,
	onChooseRecordingsDirectory,
	onOpenVideoFile,
	onOpenProjectBrowser,
	showDevUpdatePreview,
	onPreviewUpdateUi,
	appVersion,
	recordingQuality,
	onSetRecordingQuality,
}: {
	trigger: ReactElement;
	supportsHudCaptureProtection: boolean;
	hideHudFromCapture: boolean;
	onToggleHudCaptureProtection: () => void;
	onChooseRecordingsDirectory: () => void;
	onOpenVideoFile: () => void;
	onOpenProjectBrowser: () => void;
	showDevUpdatePreview: boolean;
	onPreviewUpdateUi: () => void;
	appVersion: string | null;
	recordingQuality: RecordingQuality;
	onSetRecordingQuality: (quality: RecordingQuality) => void;
}) {
	const t = useScopedT("launch");
	const { locale, setLocale } = useI18n();
	const { preference, setPreference } = useTheme();
	const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
	const open = isOpen(POPOVER_ID);

	return (
		<HudPopover
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					requestClose(POPOVER_ID);
					return;
				}
				requestOpen(POPOVER_ID);
			}}
			trigger={trigger}
			align="end"
		>
			{supportsHudCaptureProtection && (
				<DropdownItem
					icon={hideHudFromCapture ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
					selected={hideHudFromCapture}
					onClick={onToggleHudCaptureProtection}
				>
					{hideHudFromCapture
						? t("recording.hideHudFromVideo")
						: t("recording.showHudInVideo")}
				</DropdownItem>
			)}
			<DropdownItem
				icon={<FolderOpenIcon size={16} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onChooseRecordingsDirectory();
				}}
			>
				{t("recording.recordingsFolder")}
			</DropdownItem>
			<DropdownItem
				icon={<VideoCameraIcon size={16} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onOpenVideoFile();
				}}
			>
				{t("recording.openVideoFile")}
			</DropdownItem>
			<DropdownItem
				icon={<FolderOpenIcon size={16} />}
				onClick={() => {
					requestClose(POPOVER_ID);
					onOpenProjectBrowser();
				}}
			>
				{t("recording.openProject")}
			</DropdownItem>
			{showDevUpdatePreview ? (
				<DropdownItem
					icon={<ArrowClockwiseIcon size={16} />}
					onClick={() => {
						requestClose(POPOVER_ID);
						onPreviewUpdateUi();
					}}
				>
					{t("recording.previewUpdateUi", "Preview Update UI")}
				</DropdownItem>
			) : null}
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.quality", "Recording Quality")}
			</div>
			{(["720p", "1080p", "2k", "3k", "4k"] as RecordingQuality[]).map((q) => (
				<DropdownItem
					key={q}
					icon={<MonitorIcon size={16} />}
					selected={recordingQuality === q}
					onClick={() => {
						onSetRecordingQuality(q);
						requestClose(POPOVER_ID);
					}}
				>
					{QUALITY_LABELS[q]}
				</DropdownItem>
			))}
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.appearance", "Appearance")}
			</div>
			<DropdownItem
				icon={<SunIcon size={16} />}
				selected={preference === "light"}
				onClick={() => {
					setPreference("light");
					requestClose(POPOVER_ID);
				}}
			>
				{t("common.light", "Light")}
			</DropdownItem>
			<DropdownItem
				icon={<MoonIcon size={16} />}
				selected={preference === "dark"}
				onClick={() => {
					setPreference("dark");
					requestClose(POPOVER_ID);
				}}
			>
				{t("common.dark", "Dark")}
			</DropdownItem>
			<DropdownItem
				icon={<DesktopIcon size={16} />}
				selected={preference === "system"}
				onClick={() => {
					setPreference("system");
					requestClose(POPOVER_ID);
				}}
			>
				{t("common.system", "System")}
			</DropdownItem>
			<div className={styles.ddLabel} style={{ marginTop: 4 }}>
				{t("recording.language")}
			</div>
			{SUPPORTED_LOCALES.map((code) => (
				<DropdownItem
					key={code}
					icon={<TranslateIcon size={16} />}
					selected={locale === code}
					onClick={() => {
						setLocale(code as AppLocale);
						requestClose(POPOVER_ID);
					}}
				>
					{LOCALE_LABELS[code] ?? code}
				</DropdownItem>
			))}
			{appVersion && (
				<div
					style={{
						marginTop: 8,
						padding: "4px 12px",
						fontSize: 11,
						color: "var(--launch-text-muted)",
						textAlign: "center",
						userSelect: "text",
					}}
				>
					v{appVersion}
				</div>
			)}
		</HudPopover>
	);
}

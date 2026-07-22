import {
	Eye,
	EyeSlash as EyeOff,
	VideoCamera as Video,
	VideoCameraSlash as VideoOff,
} from "@phosphor-icons/react";
import { useScopedT } from "@/contexts/I18nContext";
import { DropdownItem, HudPopover } from "./PopoverScaffold";
import { useLaunchPopoverCoordinator } from "./LaunchPopoverCoordinator";
import type { DeviceOption } from "./launchPopoverTypes";
import type { ReactElement } from "react";

const POPOVER_ID = "webcam";

export function WebcamPopover({
	trigger,
	disabled,
	webcamEnabled,
	onDisableWebcam,
	canToggleFloatingPreview,
	showFloatingWebcamPreview,
	onToggleFloatingPreview,
	showWebcamControls,
	setWebcamPreviewNode,
	videoDevices,
	webcamDeviceId,
	selectedVideoDeviceId,
	selectedVideoDeviceIds,
	onSelectVideoDevice,
}: {
	trigger: ReactElement;
	disabled?: boolean;
	webcamEnabled: boolean;
	onDisableWebcam: () => void;
	canToggleFloatingPreview: boolean;
	showFloatingWebcamPreview: boolean;
	onToggleFloatingPreview: () => void;
	showWebcamControls: boolean;
	setWebcamPreviewNode: (node: HTMLVideoElement | null) => void;
	videoDevices: DeviceOption[];
	webcamDeviceId?: string;
	selectedVideoDeviceId?: string;
	selectedVideoDeviceIds?: string[];
	onSelectVideoDevice: (deviceId: string) => void;
}) {
	const t = useScopedT("launch");
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
				if (disabled) {
					return;
				}
				requestOpen(POPOVER_ID);
			}}
			trigger={trigger}
			align="center"
		>
			<div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--launch-label)]">
				{t("recording.webcam")}
			</div>
			{webcamEnabled && (
				<>
					<DropdownItem icon={<VideoOff size={16} />} onClick={() => {
						onDisableWebcam();
						requestClose(POPOVER_ID);
					}}>
						{t("recording.turnOffWebcam")}
					</DropdownItem>
					{canToggleFloatingPreview ? (
						<DropdownItem
							icon={showFloatingWebcamPreview ? <EyeOff size={16} /> : <Eye size={16} />}
							selected={showFloatingWebcamPreview}
							onClick={onToggleFloatingPreview}
						>
							{showFloatingWebcamPreview
								? t("recording.hideFloatingWebcamPreview")
								: t("recording.showFloatingWebcamPreview")}
						</DropdownItem>
					) : null}
				</>
			)}
			{!webcamEnabled && (
				<div className="px-3 py-2 text-xs text-[var(--launch-text-muted)]">{t("recording.selectWebcamToEnable")}</div>
			)}
			{showWebcamControls && (
				<div className="flex justify-center px-3 py-2">
					<div className="h-24 w-24 overflow-hidden rounded-2xl bg-[var(--launch-hover)] ring-1 ring-[var(--launch-border-strong)]">
						<video
							ref={setWebcamPreviewNode}
							className="h-full w-full object-cover"
							muted
							playsInline
							style={{ transform: "scaleX(-1)" }}
						/>
					</div>
				</div>
			)}
			{videoDevices.map((device) => {
				const selectionIndex = selectedVideoDeviceIds
					? selectedVideoDeviceIds.indexOf(device.deviceId)
					: -1;
				const isSelected =
					webcamEnabled &&
					(selectionIndex >= 0 ||
						webcamDeviceId === device.deviceId ||
						selectedVideoDeviceId === device.deviceId);

				return (
					<DropdownItem
						key={device.deviceId}
						icon={isSelected ? <Video size={16} /> : <VideoOff size={16} />}
						selected={isSelected}
						onClick={() => onSelectVideoDevice(device.deviceId)}
					>
						<span className="flex w-full items-center justify-between gap-2">
							<span className="truncate">{device.label}</span>
							{isSelected && selectionIndex >= 0 && (
								<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--launch-accent,#3b82f6)] text-[9px] font-bold text-white">
									{selectionIndex + 1}
								</span>
							)}
						</span>
					</DropdownItem>
				);
			})}
			{videoDevices.length === 0 && (
				<div className="text-center text-xs text-[var(--launch-text-muted)] py-4">{t("recording.noWebcamsFound")}</div>
			)}
		</HudPopover>
	);
}

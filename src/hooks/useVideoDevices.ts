import { useCallback, useEffect, useState } from "react";

export interface VideoDevice {
	deviceId: string;
	label: string;
	groupId: string;
}

export const MAX_SELECTED_VIDEO_DEVICES = 2;

let hasRequestedVideoLabels = false;

export function useVideoDevices(enabled: boolean = true) {
	const [devices, setDevices] = useState<VideoDevice[]>([]);
	// Selection order matters: index 0 is the primary camera, index 1 the secondary.
	// Empty array means "no explicit selection yet" (falls back to the first device).
	const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const selectedDeviceId = selectedDeviceIds[0] ?? "default";

	const setSelectedDeviceId = useCallback((deviceId: string) => {
		setSelectedDeviceIds((previous) => {
			if (deviceId === "default") {
				return [];
			}
			return [deviceId, ...previous.slice(1).filter((id) => id !== deviceId)];
		});
	}, []);

	const toggleSelectedDevice = useCallback((deviceId: string) => {
		setSelectedDeviceIds((previous) => {
			if (previous.includes(deviceId)) {
				return previous.filter((id) => id !== deviceId);
			}
			if (previous.length >= MAX_SELECTED_VIDEO_DEVICES) {
				// Replace the most recently added (secondary) selection.
				return [...previous.slice(0, MAX_SELECTED_VIDEO_DEVICES - 1), deviceId];
			}
			return [...previous, deviceId];
		});
	}, []);

	useEffect(() => {
		if (!enabled) {
			return;
		}

		let mounted = true;
		let activeLoadId = 0;

		const loadDevices = async () => {
			const loadId = ++activeLoadId;
			let permissionStream: MediaStream | null = null;

			try {
				if (mounted && loadId === activeLoadId) {
					setIsLoading(true);
					setError(null);
				}

				let allDevices = await navigator.mediaDevices.enumerateDevices();
				let videoInputs = allDevices
					.filter((device) => device.kind === "videoinput")
					.map((device, index) => ({
						deviceId: device.deviceId,
						label: device.label || `Camera ${index + 1}`,
						groupId: device.groupId,
					}));

				const needsLabelPermission =
					videoInputs.length > 0 && videoInputs.every((device) => !device.label.trim());

				if (needsLabelPermission && !hasRequestedVideoLabels) {
					permissionStream = await navigator.mediaDevices.getUserMedia({
						video: true,
						audio: false,
					});
					allDevices = await navigator.mediaDevices.enumerateDevices();
					videoInputs = allDevices
						.filter((device) => device.kind === "videoinput")
						.map((device, index) => ({
							deviceId: device.deviceId,
							label: device.label || `Camera ${index + 1}`,
							groupId: device.groupId,
						}));
					hasRequestedVideoLabels = true;
				}

				if (mounted && loadId === activeLoadId) {
					setDevices(videoInputs);
					setSelectedDeviceIds((currentIds) => {
						const stillPresent = currentIds.filter((id) =>
							videoInputs.some((device) => device.deviceId === id),
						);
						if (stillPresent.length > 0) {
							return stillPresent.length === currentIds.length ? currentIds : stillPresent;
						}
						return videoInputs.length > 0 ? [videoInputs[0].deviceId] : [];
					});
				}
			} catch (error) {
				if (mounted && loadId === activeLoadId) {
					const message =
						error instanceof Error
							? error.message
							: "Failed to enumerate video devices";
					setError(message);
					console.error("Error loading video devices:", error);
				}
			} finally {
				permissionStream?.getTracks().forEach((track) => track.stop());
				if (mounted && loadId === activeLoadId) {
					setIsLoading(false);
				}
			}
		};

		void loadDevices();

		const handleDeviceChange = () => {
			void loadDevices();
		};

		navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

		return () => {
			mounted = false;
			navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
		};
	}, [enabled]);

	return {
		devices,
		selectedDeviceId,
		setSelectedDeviceId,
		selectedDeviceIds,
		toggleSelectedDevice,
		isLoading,
		error,
	};
}

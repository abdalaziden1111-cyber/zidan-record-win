import { dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import { setCurrentProjectPath } from "../state";
import {
	getWhisperSmallModelStatus,
	downloadWhisperSmallModel,
	deleteWhisperSmallModel,
	sendWhisperModelDownloadProgress,
} from "../captions/whisper";
import { generateAutoCaptionsFromVideo } from "../captions/generate";
import { parseSrtCues } from "../captions/parser";
import { cuesToSrt, cuesToVtt } from "../captions/serialize";
import { approveUserPath, getRecordingsDir } from "../utils";

export function registerCaptionHandlers() {
  ipcMain.handle('open-video-file-picker', async () => {
    try {
      const recordingsDir = await getRecordingsDir()
      const result = await dialog.showOpenDialog({
        title: 'Select Video File',
        defaultPath: recordingsDir,
        filters: [
          { name: 'Video Files', extensions: ['webm', 'mp4', 'mov', 'avi', 'mkv'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      approveUserPath(result.filePaths[0])
      setCurrentProjectPath(null)
      return {
        success: true,
        path: result.filePaths[0]
      };
    } catch (error) {
      console.error('Failed to open file picker:', error);
      return {
        success: false,
        message: 'Failed to open file picker',
        error: String(error)
      };
    }
  });

  ipcMain.handle('open-audio-file-picker', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Audio File',
        filters: [
          { name: 'Audio Files', extensions: ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      approveUserPath(result.filePaths[0])
      return {
        success: true,
        path: result.filePaths[0]
      };
    } catch (error) {
      console.error('Failed to open audio file picker:', error);
      return {
        success: false,
        message: 'Failed to open audio file picker',
        error: String(error)
      };
    }
  });

  ipcMain.handle('open-whisper-executable-picker', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Whisper Executable',
        filters: [
          { name: 'Executables', extensions: process.platform === 'win32' ? ['exe', 'cmd', 'bat'] : ['*'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      approveUserPath(result.filePaths[0])
      return { success: true, path: result.filePaths[0] }
    } catch (error) {
      console.error('Failed to open Whisper executable picker:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('open-whisper-model-picker', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Whisper Model',
        filters: [
          { name: 'Whisper Models', extensions: ['bin'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true }
      }

      approveUserPath(result.filePaths[0])
      return { success: true, path: result.filePaths[0] }
    } catch (error) {
      console.error('Failed to open Whisper model picker:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('get-whisper-small-model-status', async () => {
    try {
      return await getWhisperSmallModelStatus()
    } catch (error) {
      return { success: false, exists: false, path: null, error: String(error) }
    }
  })

  ipcMain.handle('download-whisper-small-model', async (event) => {
    try {
      const existing = await getWhisperSmallModelStatus()
      if (existing.exists) {
        sendWhisperModelDownloadProgress(event.sender, {
          status: 'downloaded',
          progress: 100,
          path: existing.path,
        })
        return { success: true, path: existing.path, alreadyDownloaded: true }
      }

      const modelPath = await downloadWhisperSmallModel(event.sender)
      return { success: true, path: modelPath }
    } catch (error) {
      console.error('Failed to download Whisper small model:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('delete-whisper-small-model', async (event) => {
    try {
      await deleteWhisperSmallModel()
      sendWhisperModelDownloadProgress(event.sender, {
        status: 'idle',
        progress: 0,
        path: null,
      })
      return { success: true }
    } catch (error) {
      console.error('Failed to delete Whisper small model:', error)
      // Verify whether the file was actually removed despite the error
      const status = await getWhisperSmallModelStatus()
      if (!status.exists) {
        // File is gone — treat as success
        sendWhisperModelDownloadProgress(event.sender, {
          status: 'idle',
          progress: 0,
          path: null,
        })
        return { success: true }
      }
      sendWhisperModelDownloadProgress(event.sender, {
        status: 'error',
        progress: 0,
        path: null,
        error: String(error),
      })
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('generate-auto-captions', async (_, options: {
    videoPath: string
    whisperExecutablePath: string
    whisperModelPath: string
    language?: string
  }) => {
    try {
      const result = await generateAutoCaptionsFromVideo(options)
      return {
        success: true,
        cues: result.cues,
        message: result.audioSourceLabel === 'recording'
          ? `Generated ${result.cues.length} caption cues.`
          : `Generated ${result.cues.length} caption cues from the ${result.audioSourceLabel}.`,
      }
    } catch (error) {
      console.error('Failed to generate auto captions:', error)
      return {
        success: false,
        error: String(error),
        message: 'Failed to generate auto captions',
      }
    }
  })

  ipcMain.handle('import-srt-captions', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import SRT Captions',
        filters: [
          { name: 'SubRip Subtitles', extensions: ['srt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const content = await fs.readFile(result.filePaths[0], 'utf-8');
      const cues = parseSrtCues(content);
      return { success: true, cues };
    } catch (error) {
      console.error('Failed to import SRT captions:', error);
      return { success: false, error: String(error) };
    }
  })

  ipcMain.handle('export-srt-captions', async (_, data: {
    cues: { startMs: number; endMs: number; text: string }[];
    suggestedName?: string;
  }) => {
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export Captions as SRT',
        defaultPath: data.suggestedName || 'captions.srt',
        filters: [
          { name: 'SubRip Subtitles', extensions: ['srt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const srtContent = cuesToSrt(data.cues);
      await fs.writeFile(result.filePath, srtContent, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Failed to export SRT captions:', error);
      return { success: false, error: String(error) };
    }
  })

  ipcMain.handle('export-vtt-captions', async (_, data: {
    cues: { startMs: number; endMs: number; text: string }[];
    suggestedName?: string;
  }) => {
    try {
      const result = await dialog.showSaveDialog({
        title: 'Export Captions as WebVTT',
        defaultPath: data.suggestedName || 'captions.vtt',
        filters: [
          { name: 'WebVTT Subtitles', extensions: ['vtt'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      const vttContent = cuesToVtt(data.cues);
      await fs.writeFile(result.filePath, vttContent, 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Failed to export VTT captions:', error);
      return { success: false, error: String(error) };
    }
  })

}

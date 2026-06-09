package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	skewRepairMinSec       = 0.025
	vfrFPSDeltaRatio       = 0.002
	avUnifiedThresholdSec  = 0.05
	mediaTimingContractVer = "1.0"
	timelineAxisSourceVideo = "source_video_pts"
)

// MediaTimingContract is the SSOT shared by Go, Python, and the web UI.
type MediaTimingContract struct {
	SourceMediaPath         string   `json:"source_media_path"`
	WhisperAudioPath        string   `json:"whisper_audio_path,omitempty"`
	VideoDurationSec        float64  `json:"video_duration_sec"`
	AudioDurationSec        float64  `json:"audio_duration_sec,omitempty"`
	VideoStartTimeSec       float64  `json:"video_start_time_sec"`
	AudioStartTimeSec       float64  `json:"audio_start_time_sec"`
	AvStartSkewSec          float64  `json:"av_start_skew_sec"`
	AvDurationDeltaSec      float64  `json:"av_duration_delta_sec,omitempty"`
	TargetNtscFps           string   `json:"target_ntsc_fps"`
	TimelineAxis            string   `json:"timeline_axis"`
	VfrSuspected            bool     `json:"vfr_suspected"`
	PreprocessActions       []string `json:"preprocess_actions,omitempty"`
	ContractVersion         string   `json:"contract_version"`
	Ok                      bool     `json:"ok"`
	Error                   string   `json:"error,omitempty"`
	WordTimelineDurationSec float64  `json:"word_timeline_duration_sec,omitempty"`
	PlaybackDurationSec     float64  `json:"playback_duration_sec,omitempty"`
	SourcePath              string   `json:"source_path,omitempty"`
}

type ffmpegRunError struct {
	Op     string
	Args   []string
	Stderr string
	Err    error
}

func (e *ffmpegRunError) Error() string {
	tail := strings.TrimSpace(e.Stderr)
	if len(tail) > 1200 {
		tail = tail[len(tail)-1200:]
	}
	if tail != "" {
		return fmt.Sprintf("%s failed: %v: %s", e.Op, e.Err, tail)
	}
	return fmt.Sprintf("%s failed: %v", e.Op, e.Err)
}

func (e *ffmpegRunError) Unwrap() error { return e.Err }

type MediaProcessor struct {
	FFmpegPath  string
	FFprobePath string
}

func NewMediaProcessor() (*MediaProcessor, error) {
	ff, err := resolveFFmpegExecutable()
	if err != nil {
		return nil, err
	}
	fp, err := resolveFFprobeExecutable()
	if err != nil {
		return nil, err
	}
	return &MediaProcessor{FFmpegPath: ff, FFprobePath: fp}, nil
}

func parseFrameRate(value string) (float64, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "0/0" || value == "0" || value == "0/1" {
		return 0, false
	}
	if strings.Contains(value, "/") {
		parts := strings.SplitN(value, "/", 2)
		num, err1 := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
		den, err2 := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
		if err1 != nil || err2 != nil || den <= 0 {
			return 0, false
		}
		fps := num / den
		if fps <= 0 {
			return 0, false
		}
		return fps, true
	}
	fps, err := strconv.ParseFloat(value, 64)
	if err != nil || fps <= 0 {
		return 0, false
	}
	return fps, true
}

func targetNTSCFPSFromRate(fps float64) string {
	if fps >= 50 {
		return "60000/1001"
	}
	if fps <= 25 {
		return "24000/1001"
	}
	return "30000/1001"
}

func pickContentFPS(rFrameRate, avgFrameRate string, vfrSuspected bool) float64 {
	if vfrSuspected {
		if fps, ok := parseFrameRate(avgFrameRate); ok {
			return fps
		}
	}
	if fps, ok := parseFrameRate(avgFrameRate); ok {
		return fps
	}
	if fps, ok := parseFrameRate(rFrameRate); ok {
		return fps
	}
	return 30
}

// GetTargetNTSCFPS returns the NTSC CFR string for export based on v:0 frame rates.
func GetTargetNTSCFPS(ctx context.Context, inputPath string) (string, error) {
	probe, err := ProbeMediaTiming(ctx, inputPath)
	if err != nil {
		return "", err
	}
	if !probe.Ok {
		return "", fmt.Errorf("probe failed: %s", probe.Error)
	}
	return probe.TargetNtscFps, nil
}

type ffprobeStream struct {
	Index        int     `json:"index"`
	CodecType    string  `json:"codec_type"`
	StartTime    string  `json:"start_time"`
	Duration     string  `json:"duration"`
	RFrameRate   string  `json:"r_frame_rate"`
	AvgFrameRate string  `json:"avg_frame_rate"`
}

type ffprobeOutput struct {
	Streams []ffprobeStream `json:"streams"`
}

func parseProbeFloat(raw string) (float64, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "N/A" {
		return 0, false
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v <= 0 || math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, false
	}
	return v, true
}

func runCommand(ctx context.Context, op string, name string, args []string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	hideExec(cmd)
	cmd.Env = prependFFmpegBinToPath(os.Environ())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", &ffmpegRunError{
			Op:     op,
			Args:   append([]string{name}, args...),
			Stderr: stderr.String(),
			Err:    err,
		}
	}
	return string(out), nil
}

// ProbeMediaTiming probes v:0/a:0 stream timing. Format duration is never used for -t SSOT.
func ProbeMediaTiming(ctx context.Context, inputPath string) (*MediaTimingContract, error) {
	inputPath = filepath.Clean(inputPath)
	contract := &MediaTimingContract{
		SourceMediaPath:  inputPath,
		SourcePath:       inputPath,
		TimelineAxis:     timelineAxisSourceVideo,
		ContractVersion:  mediaTimingContractVer,
		PreprocessActions: []string{},
	}

	mp, err := NewMediaProcessor()
	if err != nil {
		contract.Error = err.Error()
		return contract, err
	}

	args := []string{
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=index,codec_type,start_time,duration,r_frame_rate,avg_frame_rate",
		"-of", "json",
		inputPath,
	}
	videoJSON, err := runCommand(ctx, "ffprobe video v:0", mp.FFprobePath, args)
	if err != nil {
		contract.Error = err.Error()
		return contract, err
	}

	var videoOut ffprobeOutput
	if err := json.Unmarshal([]byte(videoJSON), &videoOut); err != nil {
		contract.Error = fmt.Sprintf("ffprobe video json: %v", err)
		return contract, fmt.Errorf("ffprobe video json: %w", err)
	}
	if len(videoOut.Streams) == 0 || videoOut.Streams[0].CodecType != "video" {
		contract.Error = "video stream v:0 not found"
		return contract, fmt.Errorf("%s", contract.Error)
	}
	vStream := videoOut.Streams[0]
	videoDur, ok := parseProbeFloat(vStream.Duration)
	if !ok || videoDur <= 0 {
		contract.Error = "video stream v:0 duration missing or invalid (format duration fallback forbidden)"
		return contract, fmt.Errorf("%s", contract.Error)
	}
	videoStart, _ := parseProbeFloat(vStream.StartTime)

	args = []string{
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=index,codec_type,start_time,duration",
		"-of", "json",
		inputPath,
	}
	audioJSON, err := runCommand(ctx, "ffprobe audio a:0", mp.FFprobePath, args)
	if err != nil {
		contract.Error = err.Error()
		return contract, err
	}

	var audioOut ffprobeOutput
	if err := json.Unmarshal([]byte(audioJSON), &audioOut); err != nil {
		contract.Error = fmt.Sprintf("ffprobe audio json: %v", err)
		return contract, fmt.Errorf("ffprobe audio json: %w", err)
	}

	var audioDur, audioStart float64
	if len(audioOut.Streams) > 0 && audioOut.Streams[0].CodecType == "audio" {
		audioDur, _ = parseProbeFloat(audioOut.Streams[0].Duration)
		audioStart, _ = parseProbeFloat(audioOut.Streams[0].StartTime)
	} else {
		contract.Error = "audio stream a:0 not found"
		return contract, fmt.Errorf("%s", contract.Error)
	}

	rFPS, _ := parseFrameRate(vStream.RFrameRate)
	avgFPS, _ := parseFrameRate(vStream.AvgFrameRate)
	vfr := false
	if rFPS > 0 && avgFPS > 0 {
		vfr = math.Abs(rFPS-avgFPS)/math.Max(rFPS, avgFPS) > vfrFPSDeltaRatio
	}

	skew := videoStart - audioStart
	contentFPS := pickContentFPS(vStream.RFrameRate, vStream.AvgFrameRate, vfr)

	contract.VideoDurationSec = videoDur
	contract.AudioDurationSec = audioDur
	contract.VideoStartTimeSec = videoStart
	contract.AudioStartTimeSec = audioStart
	contract.AvStartSkewSec = skew
	if audioDur > 0 {
		contract.AvDurationDeltaSec = videoDur - audioDur
	}
	contract.TargetNtscFps = targetNTSCFPSFromRate(contentFPS)
	contract.VfrSuspected = vfr
	contract.WordTimelineDurationSec = videoDur
	contract.PlaybackDurationSec = videoDur
	applyUnifiedMediaTiming(contract)
	contract.Ok = true
	return contract, nil
}

// applyUnifiedMediaTiming masks small container A/V residuals for UI SSOT (video-master).
func applyUnifiedMediaTiming(contract *MediaTimingContract) {
	if contract == nil {
		return
	}
	if contract.VideoDurationSec > 0 && contract.AudioDurationSec > 0 {
		delta := contract.VideoDurationSec - contract.AudioDurationSec
		if math.Abs(delta) <= avUnifiedThresholdSec {
			contract.AudioDurationSec = contract.VideoDurationSec
			contract.AvDurationDeltaSec = 0
			contract.PlaybackDurationSec = contract.VideoDurationSec
			contract.WordTimelineDurationSec = contract.VideoDurationSec
		}
	}
	if math.Abs(contract.AvStartSkewSec) <= avUnifiedThresholdSec {
		contract.AvStartSkewSec = 0
	}
}

// BuildSkewFilter returns the audio filter prefix for video.currentTime axis alignment.
func BuildSkewFilter(skewSec float64) (filter string, actions []string) {
	if math.Abs(skewSec) < skewRepairMinSec {
		return "", nil
	}
	if skewSec > 0 {
		filter = fmt.Sprintf("atrim=start=%.6f,", skewSec)
		actions = []string{fmt.Sprintf("atrim_start_%.3fs", skewSec)}
		return filter, actions
	}
	ms := int(math.Round(-skewSec * 1000))
	if ms < 0 {
		ms = 0
	}
	filter = fmt.Sprintf("adelay=%d|%d,", ms, ms)
	actions = []string{fmt.Sprintf("adelay_%dms", ms)}
	return filter, actions
}

// EscapeWindowsPath escapes a path for FFmpeg subtitles/ass filter on Windows.
func EscapeWindowsPath(path string) string {
	s := filepath.ToSlash(filepath.Clean(path))
	s = strings.ReplaceAll(s, ":", "\\:")
	s = strings.ReplaceAll(s, "'", "\\'")
	return s
}

// PreprocessAudioForWhisper extracts 16 kHz mono WAV on the source video PTS axis.
func (mp *MediaProcessor) PreprocessAudioForWhisper(ctx context.Context, inputPath, outputPath string, probe *MediaTimingContract) error {
	if probe == nil || !probe.Ok {
		return fmt.Errorf("invalid media timing contract")
	}
	if probe.VideoDurationSec <= 0 {
		return fmt.Errorf("video duration must be > 0")
	}

	skewFilter, skewActions := BuildSkewFilter(probe.AvStartSkewSec)
	filterComplex := fmt.Sprintf(
		"[0:v]setpts=PTS-STARTPTS,nullsink;[0:a]%sasetpts=PTS-STARTPTS,aresample=16000:async=1:min_hard_comp=0.010:max_soft_comp=0.010,apad,aformat=sample_fmts=s16:channel_layouts=mono[aout]",
		skewFilter,
	)

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}

	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-i", inputPath,
		"-filter_complex", filterComplex,
		"-map", "[aout]",
		"-t", fmt.Sprintf("%.6f", probe.VideoDurationSec),
		outputPath,
	}
	if err := mp.runFFmpeg(ctx, "preprocess audio for whisper", args); err != nil {
		return err
	}

	info, err := os.Stat(outputPath)
	if err != nil || info.Size() == 0 {
		return fmt.Errorf("preprocess output missing or empty: %s", outputPath)
	}

	probe.PreprocessActions = append(probe.PreprocessActions, "nullsink_video_master")
	probe.PreprocessActions = append(probe.PreprocessActions, skewActions...)
	probe.PreprocessActions = append(probe.PreprocessActions, "aresample_16k_mono")
	probe.PreprocessActions = append(probe.PreprocessActions, fmt.Sprintf("truncate_t_%.3fs", probe.VideoDurationSec))
	probe.WhisperAudioPath = outputPath
	return nil
}

// ExportPlainBurnInVideo burns SRT subtitles with CFR NTSC video and lip-synced audio.
func (mp *MediaProcessor) ExportPlainBurnInVideo(ctx context.Context, inputPath, srtPath, outputPath string, probe *MediaTimingContract) error {
	if probe == nil || !probe.Ok {
		return fmt.Errorf("invalid media timing contract")
	}
	if probe.TargetNtscFps == "" {
		return fmt.Errorf("target NTSC fps missing from contract")
	}

	skewFilter, _ := BuildSkewFilter(probe.AvStartSkewSec)
	srtEsc := EscapeWindowsPath(srtPath)
	filterComplex := fmt.Sprintf(
		"[0:v]fps=fps=%s,setpts=PTS-STARTPTS,subtitles='%s':charenc=UTF-8[vout];[0:a]%saresample=async=1,asetpts=PTS-STARTPTS[aout]",
		probe.TargetNtscFps,
		srtEsc,
		skewFilter,
	)

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}

	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-i", inputPath,
		"-filter_complex", filterComplex,
		"-map", "[vout]",
		"-map", "[aout]",
		"-c:v", "libx264",
		"-crf", "20",
		"-c:a", "aac",
		"-ar", "48000",
		"-shortest",
		outputPath,
	}
	return mp.runFFmpeg(ctx, "export plain burn-in", args)
}

func (mp *MediaProcessor) runFFmpeg(ctx context.Context, op string, args []string) error {
	cmd := exec.CommandContext(ctx, mp.FFmpegPath, args...)
	hideExec(cmd)
	cmd.Env = prependFFmpegBinToPath(os.Environ())
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return &ffmpegRunError{
			Op:     op,
			Args:   append([]string{mp.FFmpegPath}, args...),
			Stderr: stderr.String(),
			Err:    err,
		}
	}
	return nil
}

// PrepareMediaForWhisper probes and extracts whisper audio into jobDir.
func PrepareMediaForWhisper(ctx context.Context, sourcePath, jobDir string) (*MediaTimingContract, error) {
	sourcePath = filepath.Clean(sourcePath)
	if err := os.MkdirAll(jobDir, 0o755); err != nil {
		return nil, err
	}

	probeCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	contract, err := ProbeMediaTiming(probeCtx, sourcePath)
	if err != nil {
		return contract, err
	}

	mp, err := NewMediaProcessor()
	if err != nil {
		contract.Ok = false
		contract.Error = err.Error()
		return contract, err
	}

	outputWAV := filepath.Join(jobDir, "whisper-audio.wav")
	preCtx, cancelPre := context.WithTimeout(ctx, 30*time.Minute)
	defer cancelPre()
	if err := mp.PreprocessAudioForWhisper(preCtx, sourcePath, outputWAV, contract); err != nil {
		contract.Ok = false
		contract.Error = err.Error()
		return contract, err
	}

	contractPath := filepath.Join(jobDir, "media_timing_contract.json")
	payload, err := json.MarshalIndent(contract, "", "  ")
	if err != nil {
		return contract, err
	}
	if err := os.WriteFile(contractPath, payload, 0o644); err != nil {
		return contract, err
	}

	return contract, nil
}

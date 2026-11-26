import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:share_plus/share_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'ffi/voxora_ffi.dart';
import 'models/studio_models.dart';
import 'theme/studio_theme.dart';
import 'widgets/studio_widgets.dart';

void main() => runApp(const VoxoraStudioApp());

class VoxoraStudioApp extends StatefulWidget {
  const VoxoraStudioApp({super.key});

  @override
  State<VoxoraStudioApp> createState() => _VoxoraStudioAppState();
}

class _VoxoraStudioAppState extends State<VoxoraStudioApp> {
  ThemeMode _themeMode = ThemeMode.dark;

  @override
  void initState() {
    super.initState();
    _loadTheme();
  }

  Future<void> _loadTheme() async {
    final prefs = await SharedPreferences.getInstance();
    final isDark = prefs.getBool('voxora_dark_mode') ?? true;
    if (mounted) {
      setState(() => _themeMode = isDark ? ThemeMode.dark : ThemeMode.light);
    }
  }

  Future<void> _toggleTheme() async {
    final nextDark = _themeMode != ThemeMode.dark;
    setState(() => _themeMode = nextDark ? ThemeMode.dark : ThemeMode.light);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool('voxora_dark_mode', nextDark);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Voxora Studio',
      debugShowCheckedModeBanner: false,
      themeMode: _themeMode,
      theme: buildStudioTheme(Brightness.light),
      darkTheme: buildStudioTheme(Brightness.dark),
      home: StudioWorkspacePage(
        isDark: _themeMode == ThemeMode.dark,
        onToggleTheme: _toggleTheme,
      ),
    );
  }
}

class StudioWorkspacePage extends StatefulWidget {
  const StudioWorkspacePage({
    super.key,
    required this.isDark,
    required this.onToggleTheme,
  });

  final bool isDark;
  final VoidCallback onToggleTheme;

  @override
  State<StudioWorkspacePage> createState() => _StudioWorkspacePageState();
}

class _StudioWorkspacePageState extends State<StudioWorkspacePage> {
  final _ffi = VoxoraFfi.instance;

  int _tabIndex = 0;
  bool _engineRunning = false;
  bool _monitorLive = false;
  bool _isPlaying = false;
  bool _isRecording = false;
  bool _isImporting = false;
  bool _isExporting = false;
  double _exportProgress = 0.0;
  int _exportFormat = 0; // 0 = WAV 16-bit, 1 = WAV 24-bit, 2 = M4A AAC

  VocalSettings _vocal = const VocalSettings();
  MasterSettings _master = const MasterSettings();
  List<VocalPresetItem> _customPresets = [];
  String? _activePresetName = 'Pop Studio';

  final List<AudioTrackModel> _tracks = [];
  final List<ExportedFileModel> _exports = [];
  int _nextTrackId = 1;
  String? _activeRecRawPath;

  final List<double> _detHistory = [];
  final List<double> _corHistory = [];
  double _inLevel = 0;
  double _outLevel = 0;
  double _lufs = -70;
  double _compGr = 0;
  double _playheadSec = 0;
  double _totalSec = 0;

  Timer? _telemTimer;

  @override
  void initState() {
    super.initState();
    _loadCustomPresets();
    _loadSavedExports();
  }

  @override
  void dispose() {
    _telemTimer?.cancel();
    if (_engineRunning) _ffi.stop();
    super.dispose();
  }

  Future<void> _loadCustomPresets() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getStringList('voxora_custom_presets') ?? [];
    if (mounted) {
      setState(() {
        _customPresets = raw.map(VocalPresetItem.decode).toList();
      });
    }
  }

  Future<void> _loadSavedExports() async {
    final dir = await getApplicationDocumentsDirectory();
    final expDir = Directory('${dir.path}/exports');
    if (!await expDir.exists()) return;
    final files = expDir.listSync().whereType<File>().toList()
      ..sort((a, b) => b.statSync().modified.compareTo(a.statSync().modified));
    if (mounted) {
      setState(() {
        _exports.clear();
        for (final f in files) {
          final stat = f.statSync();
          final name = f.path.split('/').last;
          final ext = name.split('.').last.toUpperCase();
          _exports.add(ExportedFileModel(
            path: f.path,
            name: name,
            formatLabel: ext,
            sizeBytes: stat.size,
            createdAt: stat.modified,
          ));
        }
      });
    }
  }

  Future<bool> _ensureEngineStarted({bool requireMic = false}) async {
    if (_engineRunning) {
      if (requireMic && !await Permission.microphone.isGranted) {
        final micOk = await Permission.microphone.request().isGranted;
        if (!micOk) {
          _showMsg('Autorise le microphone pour enregistrer ta voix.');
          return false;
        }
      }
      return true;
    }
    if (requireMic) {
      final micOk = await Permission.microphone.request().isGranted;
      if (!micOk) {
        _showMsg('Autorise le microphone pour enregistrer ta voix.');
        return false;
      }
    }
    _ffi.applyVocal(_vocal);
    _ffi.applyMaster(_master);
    _ffi.setMonitor(_monitorLive);
    if (!_ffi.start()) {
      _showMsg('Impossible d’ouvrir le flux audio Oboe.');
      return false;
    }
    _telemTimer?.cancel();
    _telemTimer = Timer.periodic(const Duration(milliseconds: 33), (_) {
      if (!mounted) return;
      final det = _ffi.detMidi;
      final cor = _ffi.corMidi;
      setState(() {
        _detHistory.add(det);
        _corHistory.add(cor);
        if (_detHistory.length > 180) _detHistory.removeAt(0);
        if (_corHistory.length > 180) _corHistory.removeAt(0);
        _inLevel = _ffi.inLevel;
        _outLevel = _ffi.outLevel;
        _lufs = _ffi.lufs;
        _compGr = _ffi.compGrDb;
        _playheadSec = _ffi.playheadSec;
        _totalSec = _ffi.totalSec;
        if (_isExporting) _exportProgress = _ffi.renderProgress;
      });
    });
    setState(() => _engineRunning = true);
    return true;
  }

  void _showMsg(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  void _updateVocal(VocalSettings next) {
    setState(() => _vocal = next);
    if (_engineRunning) _ffi.applyVocal(next);
  }

  void _updateMaster(MasterSettings next) {
    setState(() => _master = next);
    if (_engineRunning) _ffi.applyMaster(next);
  }

  Future<void> _importAudioFiles({required bool asVocal}) async {
    if (!await _ensureEngineStarted()) return;
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.custom,
      allowedExtensions: const ['wav', 'mp3', 'aac', 'm4a', 'ogg', 'flac'],
    );
    if (result == null || result.files.isEmpty) return;

    setState(() => _isImporting = true);
    final dir = await getTemporaryDirectory();
    final cacheDir = Directory('${dir.path}/voxora_tracks');
    if (!await cacheDir.exists()) await cacheDir.create(recursive: true);

    int importedCount = 0;
    for (final file in result.files) {
      final path = file.path;
      if (path == null) continue;
      final id = _nextTrackId++;
      final rawPath = '${cacheDir.path}/track_$id.raw';
      final res = await _ffi.importTrackAsync(id, path, rawPath, asVocal);
      if (res.ok) {
        final track = AudioTrackModel(
          id: id,
          name: file.name,
          rawPath: rawPath,
          isVocal: asVocal,
          totalFrames: res.totalFrames,
          peaks: res.peaks,
        );
        _ffi.updateTrack(track);
        setState(() => _tracks.add(track));
        importedCount++;
      } else {
        _showMsg('Format non supporté ou fichier corrompu : ${file.name}');
      }
    }

    setState(() => _isImporting = false);
    if (importedCount > 0) {
      _showMsg('$importedCount piste(s) importée(s) en streaming disque.');
    }
  }

  Future<void> _toggleRecord() async {
    if (!await _ensureEngineStarted(requireMic: true)) return;
    if (!_isRecording) {
      final dir = await getTemporaryDirectory();
      final cacheDir = Directory('${dir.path}/voxora_tracks');
      if (!await cacheDir.exists()) await cacheDir.create(recursive: true);
      final id = _nextTrackId;
      _activeRecRawPath = '${cacheDir.path}/rec_$id.raw';
      if (!_ffi.startRecording(_activeRecRawPath!)) {
        _showMsg('Impossible de créer le fichier d’enregistrement.');
        return;
      }
      if (_tracks.isNotEmpty && !_isPlaying) {
        _ffi.setTransport(play: true);
        _isPlaying = true;
      }
      setState(() => _isRecording = true);
    } else {
      final frames = _ffi.stopRecording();
      if (_isPlaying) {
        _ffi.setTransport(play: false);
        _isPlaying = false;
      }
      setState(() => _isRecording = false);

      final rawPath = _activeRecRawPath;
      _activeRecRawPath = null;
      if (rawPath != null && frames > 0) {
        final id = _nextTrackId++;
        final res = _ffi.registerRawTrack(id, rawPath, true);
        if (res.ok) {
          final track = AudioTrackModel(
            id: id,
            name: 'Voix enregistrée #${_tracks.where((t) => t.isVocal).length + 1}',
            rawPath: rawPath,
            isVocal: true,
            totalFrames: res.totalFrames,
            peaks: res.peaks,
          );
          _ffi.updateTrack(track);
          setState(() => _tracks.add(track));
        }
      }
    }
  }

  Future<void> _togglePlay() async {
    if (_tracks.isEmpty) {
      _showMsg('Importe un instrumental ou enregistre une voix d’abord.');
      return;
    }
    if (!await _ensureEngineStarted()) return;
    final next = !_isPlaying;
    _ffi.setTransport(play: next);
    setState(() => _isPlaying = next);
  }

  void _stopTransport() {
    if (!_engineRunning) return;
    if (_isRecording) {
      _toggleRecord();
      return;
    }
    _ffi.setTransport(play: false, seekSec: 0.0);
    setState(() {
      _isPlaying = false;
      _playheadSec = 0;
    });
  }

  Future<void> _saveCustomPresetDialog() async {
    final ctrl = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Enregistrer le preset vocal'),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Nom du preset'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Annuler'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text('Sauvegarder'),
          ),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;

    final item = VocalPresetItem(
      name: name,
      isCustom: true,
      data: _vocal.toJson(),
    );
    setState(() {
      _customPresets.add(item);
      _activePresetName = name;
    });
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(
      'voxora_custom_presets',
      _customPresets.map((e) => e.encode()).toList(),
    );
  }

  Future<void> _runOfflineExport() async {
    if (_tracks.isEmpty) {
      _showMsg('Ajoute au moins une piste avant d’exporter.');
      return;
    }
    if (!await _ensureEngineStarted()) return;
    if (_isPlaying) _stopTransport();

    setState(() {
      _isExporting = true;
      _exportProgress = 0;
    });

    final docs = await getApplicationDocumentsDirectory();
    final expDir = Directory('${docs.path}/exports');
    if (!await expDir.exists()) await expDir.create(recursive: true);

    final stamp = DateTime.now().millisecondsSinceEpoch;
    final ext = _exportFormat == 2 ? 'm4a' : 'wav';
    final tag = _exportFormat == 1 ? '24bit' : (_exportFormat == 2 ? 'aac' : '16bit');
    final outPath = '${expDir.path}/voxora_master_${tag}_$stamp.$ext';

    final ok = await _ffi.renderOfflineAsync(outPath, _exportFormat);
    setState(() {
      _isExporting = false;
      _exportProgress = ok ? 1.0 : 0.0;
    });

    if (ok) {
      await _loadSavedExports();
      _showMsg('Master exporté : voxora_master_${tag}_$stamp.$ext');
      setState(() => _tabIndex = 3);
    } else {
      _showMsg('Échec du rendu hors-ligne pour ce format.');
    }
  }

  String get _activeNoteLabel {
    final m = _corHistory.isNotEmpty && _corHistory.last > 0
        ? _corHistory.last
        : (_detHistory.isNotEmpty ? _detHistory.last : 0.0);
    if (m <= 0) return '–';
    final rounded = m.round();
    final name = kNoteNames[((rounded % 12) + 12) % 12];
    final oct = (rounded ~/ 12) - 1;
    return '$name$oct';
  }

  @override
  Widget build(BuildContext context) {
    final sc = Theme.of(context).extension<StudioColors>()!;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: sc.surface,
        elevation: 0,
        titleSpacing: 16,
        title: Row(
          children: [
            Expanded(
              child: Text(
                'Voxora Studio',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w800,
                  color: sc.textPrimary,
                ),
              ),
            ),
            IconButton(
              tooltip: _monitorLive ? 'Couper l’écoute directe' : 'Activer l’écoute directe',
              onPressed: () {
                setState(() => _monitorLive = !_monitorLive);
                if (_engineRunning) _ffi.setMonitor(_monitorLive);
              },
              icon: Icon(
                _monitorLive ? Icons.headphones : Icons.headset_off,
                color: _monitorLive ? sc.cyan : sc.textSecondary,
              ),
            ),
            IconButton(
              tooltip: widget.isDark ? 'Mode Clair Studio' : 'Mode Sombre Studio',
              onPressed: widget.onToggleTheme,
              icon: Icon(
                widget.isDark ? Icons.light_mode_outlined : Icons.dark_mode_outlined,
                color: sc.textPrimary,
              ),
            ),
          ],
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(44),
          child: Container(
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: sc.border)),
            ),
            child: Row(
              children: [
                _navTab(0, 'Studio', sc),
                _navTab(1, 'Effets Voix', sc),
                _navTab(2, 'Mastering', sc),
                _navTab(3, 'Mes Exports', sc),
              ],
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
            color: sc.surfaceElevated,
            child: Text(
              'Casque filaire recommandé en mode direct (sans casque : larsen ; Bluetooth : latence).',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: sc.textSecondary),
            ),
          ),
          Expanded(
            child: IndexedStack(
              index: _tabIndex,
              children: [
                _buildStudioTab(sc),
                _buildVocalFxTab(sc),
                _buildMasteringTab(sc),
                _buildExportsTab(sc),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: _buildTransportBar(sc),
    );
  }

  Widget _navTab(int idx, String label, StudioColors sc) {
    final active = _tabIndex == idx;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _tabIndex = idx),
        child: Container(
          height: 44,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: active ? sc.amber : Colors.transparent,
                width: 2.5,
              ),
            ),
          ),
          child: Text(
            label,
            maxLines: 1,
            softWrap: false,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: active ? FontWeight.w700 : FontWeight.w500,
              color: active ? sc.amber : sc.textSecondary,
            ),
          ),
        ),
      ),
    );
  }

  // ---------- ONGLET 1 : STUDIO / MULTI-PISTE ----------
  Widget _buildStudioTab(StudioColors sc) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // Moniteur Pitch & VU
        Container(
          height: 170,
          decoration: BoxDecoration(
            color: sc.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: sc.border),
          ),
          child: Stack(
            children: [
              Positioned.fill(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: CustomPaint(
                    painter: PitchPainter(
                      det: _detHistory,
                      cor: _corHistory,
                      mask: _vocal.scaleMask,
                      keyIndex: _vocal.key,
                      colors: sc,
                    ),
                  ),
                ),
              ),
              Positioned(
                left: 12,
                top: 10,
                child: Text(
                  _engineRunning ? 'Moteur Oboe actif' : 'Moteur en veille',
                  style: TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: _engineRunning ? sc.cyan : sc.textSecondary,
                  ),
                ),
              ),
              Positioned(
                right: 14,
                top: 8,
                child: Text(
                  _activeNoteLabel,
                  style: TextStyle(
                    fontSize: 32,
                    fontWeight: FontWeight.w800,
                    color: sc.amber,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: LevelMeterBar(
                label: 'Micro IN',
                normalized: (_inLevel * 2.2),
                color: sc.cyan,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: LevelMeterBar(
                label: 'Comp GR',
                normalized: (_compGr.abs() / 18.0),
                color: sc.danger,
                valueLabel: '${_compGr.toStringAsFixed(1)} dB',
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: LevelMeterBar(
                label: 'Master OUT',
                normalized: _outLevel,
                color: sc.amber,
                valueLabel: '${_lufs.toStringAsFixed(0)} LUFS',
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _isImporting ? null : () => _importAudioFiles(asVocal: false),
                icon: const Icon(Icons.library_music_outlined, size: 18),
                label: const Text(
                  'Importer instrumental',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: _isImporting ? null : () => _importAudioFiles(asVocal: true),
                icon: const Icon(Icons.mic_none_outlined, size: 18),
                label: const Text(
                  'Importer voix',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ],
        ),
        if (_isImporting) ...[
          const SizedBox(height: 10),
          const LinearProgressIndicator(),
        ],
        const SizedBox(height: 16),

        if (_tracks.isEmpty)
          Container(
            padding: const EdgeInsets.all(28),
            decoration: BoxDecoration(
              color: sc.surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: sc.border),
            ),
            child: Column(
              children: [
                Icon(Icons.graphic_eq, size: 36, color: sc.amber),
                const SizedBox(height: 12),
                Text(
                  'Espace de travail vierge',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: sc.textPrimary,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  'Importe un nombre illimité d’instrumentaux ou de pistes vocales (WAV, MP3, M4A, OGG, FLAC) ou lance directement un enregistrement vocal.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 13, color: sc.textSecondary),
                ),
              ],
            ),
          )
        else
          for (final track in _tracks) _buildTrackCard(track, sc),
      ],
    );
  }

  Widget _buildTrackCard(AudioTrackModel track, StudioColors sc) {
    final dur = track.durationSec > 0 ? track.durationSec : 1.0;
    final progress = (_playheadSec / dur).clamp(0.0, 1.0);

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: sc.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: sc.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${track.isVocal ? 'VOIX' : 'BEAT'} · ${track.name}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: sc.textPrimary,
                  ),
                ),
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: Icon(Icons.delete_outline, size: 18, color: sc.textSecondary),
                onPressed: () {
                  _ffi.removeTrack(track.id);
                  setState(() => _tracks.removeWhere((t) => t.id == track.id));
                },
              ),
            ],
          ),
          const SizedBox(height: 8),
          GestureDetector(
            onTapDown: (details) {
              final box = context.findRenderObject() as RenderBox?;
              if (box == null) return;
              final ratio = (details.localPosition.dx / (box.size.width - 60)).clamp(0.0, 1.0);
              final target = ratio * dur;
              _ffi.setTransport(seekSec: target);
              setState(() => _playheadSec = target);
            },
            child: SizedBox(
              height: 48,
              width: double.infinity,
              child: CustomPaint(
                painter: WaveformPainter(
                  peaks: track.peaks,
                  color: track.isVocal ? sc.amber : sc.cyan,
                  progress: progress,
                  cursorColor: sc.textPrimary,
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              _miniToggle('M', track.mute, sc.danger, sc, () {
                setState(() => track.mute = !track.mute);
                _ffi.updateTrack(track);
              }),
              const SizedBox(width: 6),
              _miniToggle('S', track.solo, sc.amber, sc, () {
                setState(() => track.solo = !track.solo);
                _ffi.updateTrack(track);
              }),
              const SizedBox(width: 6),
              if (track.isVocal)
                _miniToggle('FX', track.fxEnabled, sc.cyan, sc, () {
                  setState(() => track.fxEnabled = !track.fxEnabled);
                  _ffi.updateTrack(track);
                }),
              const Spacer(),
              Text(
                formatTimecode(dur),
                style: TextStyle(
                  fontSize: 11.5,
                  fontFamily: 'monospace',
                  color: sc.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          StudioSlider(
            label: 'Volume piste',
            value: track.volume * 100,
            min: 0,
            max: 150,
            unit: ' %',
            defaultValue: 100,
            useCyan: !track.isVocal,
            onChanged: (v) {
              setState(() => track.volume = v / 100);
              _ffi.updateTrack(track);
            },
          ),
          StudioSlider(
            label: 'Panoramique (G / D)',
            value: track.pan * 100,
            min: -100,
            max: 100,
            unit: '',
            defaultValue: 0,
            useCyan: !track.isVocal,
            onChanged: (v) {
              setState(() => track.pan = v / 100);
              _ffi.updateTrack(track);
            },
          ),
          StudioSlider(
            label: 'Calage temporel',
            value: track.offsetMs,
            min: -500,
            max: 500,
            unit: ' ms',
            defaultValue: 0,
            useCyan: !track.isVocal,
            onChanged: (v) {
              setState(() => track.offsetMs = v);
              _ffi.updateTrack(track);
            },
          ),
        ],
      ),
    );
  }

  Widget _miniToggle(
      String label, bool active, Color activeColor, StudioColors sc, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: active ? activeColor.withAlpha(45) : sc.surfaceElevated,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: active ? activeColor : sc.border),
        ),
        child: Text(
          label,
          maxLines: 1,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w700,
            color: active ? activeColor : sc.textSecondary,
          ),
        ),
      ),
    );
  }

  // ---------- ONGLET 2 : EFFETS VOIX ----------
  Widget _buildVocalFxTab(StudioColors sc) {
    final allPresets = [...kBuiltInPresets, ..._customPresets];

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'Presets vocaux',
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: sc.textPrimary,
              ),
            ),
            Row(
              children: [
                TextButton(
                  onPressed: () => _updateVocal(_vocal.copyWith(bypass: !_vocal.bypass)),
                  child: Text(_vocal.bypass ? 'Activer FX' : 'Bypass FX'),
                ),
                FilledButton.tonal(
                  onPressed: _saveCustomPresetDialog,
                  child: const Text('Sauver preset', maxLines: 1),
                ),
              ],
            ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final p in allPresets)
              ChoiceChip(
                label: Text(p.name, maxLines: 1),
                selected: _activePresetName == p.name,
                onSelected: (_) {
                  setState(() => _activePresetName = p.name);
                  _updateVocal(_vocal.applyPresetMap(p.data));
                },
              ),
          ],
        ),
        const SizedBox(height: 16),

        _fxSection('Auto-Tune & Timbre (YIN)', sc, [
          Row(
            children: [
              Expanded(
                child: DropdownButtonFormField<int>(
                  value: _vocal.key,
                  decoration: const InputDecoration(labelText: 'Tonalité'),
                  items: [
                    for (int i = 0; i < 12; i++)
                      DropdownMenuItem(value: i, child: Text(kNoteNames[i])),
                  ],
                  onChanged: (v) {
                    if (v != null) _updateVocal(_vocal.copyWith(key: v));
                  },
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: DropdownButtonFormField<String>(
                  value: _vocal.scale,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Gamme'),
                  items: [
                    for (final s in kScales.keys)
                      DropdownMenuItem(value: s, child: Text(s)),
                  ],
                  onChanged: (v) {
                    if (v != null) _updateVocal(_vocal.copyWith(scale: v));
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          StudioSlider(
            label: 'Correction de justesse',
            value: _vocal.tuneAmt,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 65,
            onChanged: (v) => _updateVocal(_vocal.copyWith(tuneAmt: v)),
          ),
          StudioSlider(
            label: 'Vitesse (100 = robot / trap)',
            value: _vocal.tuneSpeed,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 50,
            onChanged: (v) => _updateVocal(_vocal.copyWith(tuneSpeed: v)),
          ),
          StudioSlider(
            label: 'Transposition',
            value: _vocal.transpose,
            min: -24,
            max: 24,
            unit: ' ½ ton',
            defaultValue: 0,
            onChanged: (v) => _updateVocal(_vocal.copyWith(transpose: v)),
          ),
          StudioSlider(
            label: 'Formant / Timbre vocal',
            value: _vocal.formant,
            min: -12,
            max: 12,
            decimals: 1,
            unit: ' st',
            defaultValue: 0,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(formant: v)),
          ),
        ]),

        _fxSection('Nettoyage (Noise Gate & De-Esser)', sc, [
          StudioSlider(
            label: 'Seuil Noise Gate',
            value: _vocal.gateThreshDb,
            min: -70,
            max: -15,
            unit: ' dB',
            defaultValue: -52,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(gateThreshDb: v)),
          ),
          StudioSlider(
            label: 'Attaque Gate',
            value: _vocal.gateAttackMs,
            min: 1,
            max: 50,
            unit: ' ms',
            defaultValue: 5,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(gateAttackMs: v)),
          ),
          StudioSlider(
            label: 'Relâchement Gate',
            value: _vocal.gateReleaseMs,
            min: 20,
            max: 400,
            unit: ' ms',
            defaultValue: 120,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(gateReleaseMs: v)),
          ),
          StudioSlider(
            label: 'De-Esser (Sibilances)',
            value: _vocal.deesser,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 25,
            onChanged: (v) => _updateVocal(_vocal.copyWith(deesser: v)),
          ),
        ]),

        _fxSection('Égaliseur (EQ) & Compresseur Vocal', sc, [
          StudioSlider(
            label: 'Graves (Low Shelf 150 Hz)',
            value: _vocal.eqLowDb,
            min: -12,
            max: 12,
            decimals: 1,
            unit: ' dB',
            defaultValue: 2,
            onChanged: (v) => _updateVocal(_vocal.copyWith(eqLowDb: v)),
          ),
          StudioSlider(
            label: 'Présence (Médiums)',
            value: _vocal.eqMidDb,
            min: -12,
            max: 12,
            decimals: 1,
            unit: ' dB',
            defaultValue: 3,
            onChanged: (v) => _updateVocal(_vocal.copyWith(eqMidDb: v)),
          ),
          StudioSlider(
            label: 'Fréquence Présence',
            value: _vocal.eqMidFreq,
            min: 800,
            max: 6000,
            unit: ' Hz',
            defaultValue: 3200,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(eqMidFreq: v)),
          ),
          StudioSlider(
            label: 'Air (High Shelf 9.5 kHz)',
            value: _vocal.eqHighDb,
            min: -12,
            max: 12,
            decimals: 1,
            unit: ' dB',
            defaultValue: 4,
            onChanged: (v) => _updateVocal(_vocal.copyWith(eqHighDb: v)),
          ),
          StudioSlider(
            label: 'Seuil Compresseur',
            value: _vocal.compThreshDb,
            min: -40,
            max: 0,
            unit: ' dB',
            defaultValue: -18,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(compThreshDb: v)),
          ),
          StudioSlider(
            label: 'Ratio Compresseur',
            value: _vocal.compRatio,
            min: 1,
            max: 12,
            decimals: 1,
            unit: ':1',
            defaultValue: 3.5,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(compRatio: v)),
          ),
          StudioSlider(
            label: 'Gain de compensation',
            value: _vocal.compMakeupDb,
            min: 0,
            max: 18,
            decimals: 1,
            unit: ' dB',
            defaultValue: 3,
            onChanged: (v) => _updateVocal(_vocal.copyWith(compMakeupDb: v)),
          ),
        ]),

        _fxSection('Doubler, Réverbération & Delay', sc, [
          StudioSlider(
            label: 'Doubler / Chorus Stéréo',
            value: _vocal.doubler,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 15,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(doubler: v)),
          ),
          StudioSlider(
            label: 'Taille Réverbération',
            value: _vocal.reverbSize,
            min: 10,
            max: 100,
            unit: ' %',
            defaultValue: 55,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(reverbSize: v)),
          ),
          StudioSlider(
            label: 'Mix Réverbération',
            value: _vocal.reverbMix,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 22,
            onChanged: (v) => _updateVocal(_vocal.copyWith(reverbMix: v)),
          ),
          StudioSlider(
            label: 'Temps Delay / Écho',
            value: _vocal.delayMs,
            min: 60,
            max: 600,
            unit: ' ms',
            defaultValue: 260,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(delayMs: v)),
          ),
          StudioSlider(
            label: 'Feedback Delay',
            value: _vocal.delayFb,
            min: 0,
            max: 85,
            unit: ' %',
            defaultValue: 35,
            useCyan: true,
            onChanged: (v) => _updateVocal(_vocal.copyWith(delayFb: v)),
          ),
          StudioSlider(
            label: 'Mix Delay / Écho',
            value: _vocal.delayMix,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 0,
            onChanged: (v) => _updateVocal(_vocal.copyWith(delayMix: v)),
          ),
        ]),
      ],
    );
  }

  Widget _fxSection(String title, StudioColors sc, List<Widget> children) {
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: sc.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: sc.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w700,
              color: sc.amber,
            ),
          ),
          const SizedBox(height: 10),
          ...children,
        ],
      ),
    );
  }

  // ---------- ONGLET 3 : MASTERING & EXPORT ----------
  Widget _buildMasteringTab(StudioColors sc) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _fxSection('Chaîne de Masterisation (Master Bus)', sc, [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'Niveau : ${_lufs.toStringAsFixed(1)} LUFS',
                style: TextStyle(
                  fontSize: 12.5,
                  fontFamily: 'monospace',
                  color: sc.cyan,
                ),
              ),
              TextButton(
                onPressed: () => _updateMaster(_master.copyWith(bypass: !_master.bypass)),
                child: Text(_master.bypass ? 'Activer Master' : 'Bypass Master'),
              ),
            ],
          ),
          StudioSlider(
            label: 'Master EQ Bas (65 Hz)',
            value: _master.eqLowDb,
            min: -8,
            max: 8,
            decimals: 1,
            unit: ' dB',
            defaultValue: 0,
            onChanged: (v) => _updateMaster(_master.copyWith(eqLowDb: v)),
          ),
          StudioSlider(
            label: 'Master EQ Brillance (12 kHz)',
            value: _master.eqHighDb,
            min: -8,
            max: 8,
            decimals: 1,
            unit: ' dB',
            defaultValue: 1,
            onChanged: (v) => _updateMaster(_master.copyWith(eqHighDb: v)),
          ),
          StudioSlider(
            label: 'Seuil Glue Compressor',
            value: _master.glueThreshDb,
            min: -30,
            max: 0,
            unit: ' dB',
            defaultValue: -14,
            useCyan: true,
            onChanged: (v) => _updateMaster(_master.copyWith(glueThreshDb: v)),
          ),
          StudioSlider(
            label: 'Mix Glue Bus',
            value: _master.glueMix,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 35,
            useCyan: true,
            onChanged: (v) => _updateMaster(_master.copyWith(glueMix: v)),
          ),
          StudioSlider(
            label: 'Exciter harmonique (Chaleur)',
            value: _master.exciter,
            min: 0,
            max: 100,
            unit: ' %',
            defaultValue: 15,
            onChanged: (v) => _updateMaster(_master.copyWith(exciter: v)),
          ),
          StudioSlider(
            label: 'Imagerie Stéréo (Largeur)',
            value: _master.stereoWidth,
            min: 0,
            max: 180,
            unit: ' %',
            defaultValue: 108,
            useCyan: true,
            onChanged: (v) => _updateMaster(_master.copyWith(stereoWidth: v)),
          ),
          StudioSlider(
            label: 'Drive Limiteur Brickwall',
            value: _master.limiterDriveDb,
            min: 0,
            max: 12,
            decimals: 1,
            unit: ' dB',
            defaultValue: 1.5,
            onChanged: (v) => _updateMaster(_master.copyWith(limiterDriveDb: v)),
          ),
          StudioSlider(
            label: 'Plafond Limiteur (Ceiling)',
            value: _master.limiterCeilingDb,
            min: -3.0,
            max: -0.1,
            decimals: 1,
            unit: ' dBTP',
            defaultValue: -1.0,
            useCyan: true,
            onChanged: (v) => _updateMaster(_master.copyWith(limiterCeilingDb: v)),
          ),
        ]),
        _fxSection('Export Audio Hors-Ligne', sc, [
          SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('WAV 16-bit', maxLines: 1)),
              ButtonSegment(value: 1, label: Text('WAV 24-bit', maxLines: 1)),
              ButtonSegment(value: 2, label: Text('M4A / AAC', maxLines: 1)),
            ],
            selected: {_exportFormat},
            onSelectionChanged: (s) => setState(() => _exportFormat = s.first),
          ),
          const SizedBox(height: 14),
          if (_isExporting) ...[
            LinearProgressIndicator(value: _exportProgress),
            const SizedBox(height: 8),
            Text(
              'Rendu hors-ligne : ${(_exportProgress * 100).round()} %',
              style: TextStyle(fontSize: 12, color: sc.textSecondary),
            ),
            const SizedBox(height: 10),
          ],
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: _isExporting ? null : _runOfflineExport,
              icon: const Icon(Icons.download_done),
              label: const Text('Exporter le Mix / Master', maxLines: 1),
            ),
          ),
        ]),
      ],
    );
  }

  // ---------- ONGLET 4 : MES EXPORTS ----------
  Widget _buildExportsTab(StudioColors sc) {
    if (_exports.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Aucun export finalisé pour le moment. Configure ton mix dans Studio puis lance le rendu dans Mastering.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: sc.textSecondary),
          ),
        ),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.all(16),
      itemCount: _exports.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, idx) {
        final item = _exports[idx];
        final mb = (item.sizeBytes / (1024 * 1024)).toStringAsFixed(2);
        return Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: sc.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: sc.border),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        color: sc.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${item.formatLabel} · $mb Mo',
                      style: TextStyle(
                        fontSize: 12,
                        fontFamily: 'monospace',
                        color: sc.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Partager',
                icon: Icon(Icons.share_outlined, color: sc.cyan),
                onPressed: () => Share.shareXFiles([XFile(item.path)]),
              ),
              IconButton(
                tooltip: 'Supprimer',
                icon: Icon(Icons.delete_outline, color: sc.danger),
                onPressed: () async {
                  final f = File(item.path);
                  if (await f.exists()) await f.delete();
                  await _loadSavedExports();
                },
              ),
            ],
          ),
        );
      },
    );
  }

  // ---------- BARRE DE TRANSPORT FIXE EN BAS ----------
  Widget _buildTransportBar(StudioColors sc) {
    return SafeArea(
      child: Container(
        height: 64,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: sc.surface,
          border: Border(top: BorderSide(color: sc.border)),
        ),
        child: Row(
          children: [
            IconButton(
              onPressed: _togglePlay,
              icon: Icon(
                _isPlaying ? Icons.pause_rounded : Icons.play_arrow_rounded,
                size: 28,
                color: sc.amber,
              ),
              tooltip: _isPlaying ? 'Pause' : 'Lecture',
            ),
            IconButton(
              onPressed: _stopTransport,
              icon: Icon(Icons.stop_rounded, size: 26, color: sc.textPrimary),
              tooltip: 'Stop',
            ),
            IconButton(
              onPressed: _toggleRecord,
              icon: Icon(
                _isRecording ? Icons.stop_circle : Icons.fiber_manual_record,
                size: 26,
                color: sc.danger,
              ),
              tooltip: _isRecording ? 'Arrêter enregistrement' : 'Enregistrer voix',
            ),
            const Spacer(),
            Text(
              '${formatTimecode(_playheadSec)} / ${formatTimecode(_totalSec)}',
              maxLines: 1,
              style: TextStyle(
                fontSize: 13,
                fontFamily: 'monospace',
                fontWeight: FontWeight.w600,
                color: sc.textPrimary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

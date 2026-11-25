import 'dart:async';
import 'dart:ffi';
import 'dart:math' as math;

import 'package:ffi/ffi.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';

// ---------- liaison avec le moteur C++ ----------
final _l = DynamicLibrary.open('libvoxora.so');
final _start = _l.lookupFunction<Int32 Function(), int Function()>('vx_start');
final _stop = _l.lookupFunction<Void Function(), void Function()>('vx_stop');
final _set = _l.lookupFunction<
    Void Function(Int32, Int32, Float, Float, Float),
    void Function(int, int, double, double, double)>('vx_set');
final _det = _l.lookupFunction<Float Function(), double Function()>('vx_det');
final _cor = _l.lookupFunction<Float Function(), double Function()>('vx_cor');
final _rec = _l.lookupFunction<Void Function(Int32), void Function(int)>('vx_rec');
final _save = _l.lookupFunction<Int32 Function(Pointer<Utf8>),
    int Function(Pointer<Utf8>)>('vx_save');

const keys = ['Do', 'Do#', 'Ré', 'Ré#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const scales = <String, List<int>>{
  'Chromatique': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  'Majeure': [0, 2, 4, 5, 7, 9, 11],
  'Mineure': [0, 2, 3, 5, 7, 8, 10],
  'Pentatonique majeure': [0, 2, 4, 7, 9],
  'Pentatonique mineure': [0, 3, 5, 7, 10],
};
final _fx = _l.lookupFunction<
    Void Function(Float, Float, Float, Float, Float, Float),
    void Function(double, double, double, double, double, double)>('vx_fx');

const presets = <String, List<double>>{
  // correction %, vitesse %, graves, présence, air, compresseur %, réverb %, écho %
  'Naturel': [0, 50, 0, 2, 2, 30, 8, 0],
  'Pop pro': [65, 50, 2, 3, 4, 55, 22, 0],
  'Trap Tune': [100, 100, 0, 2, 3, 70, 18, 22],
  'Radio': [0, 50, -10, 6, -8, 80, 0, 0],
  'Salle': [40, 40, 0, 2, 3, 40, 65, 15],
};

void main() => runApp(const VoxoraApp());

class VoxoraApp extends StatelessWidget {
  const VoxoraApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Voxora Live',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          brightness: Brightness.dark,
          scaffoldBackgroundColor: const Color(0xFF0E1322),
          colorScheme: const ColorScheme.dark(primary: Color(0xFFFFB347)),
          useMaterial3: true,
        ),
        home: const LivePage(),
      );
}

class LivePage extends StatefulWidget {
  const LivePage({super.key});
  @override
  State<LivePage> createState() => _LivePageState();
}

class _LivePageState extends State<LivePage> {
  int key = 0;
  String scale = 'Chromatique';
  double amt = 65, spd = 50, trn = 0;
  double bass = 2, pres = 3, air = 4, comp = 55, rev = 22, echo = 0;
  bool live = false, recording = false;
  final det = <double>[], cor = <double>[];
  Timer? _timer;

  int get mask => scales[scale]!.fold(0, (m, i) => m | (1 << i));
  void _apply() {
    _set(key, mask, amt / 100, spd / 100, trn);
    _fx(bass, pres, air, comp / 100, rev / 100, echo / 100);
  }
  void _snack(String t) =>
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(t)));

  Future<void> _toggle() async {
    if (live) {
      _timer?.cancel();
      if (recording) await _toggleRec();
      _stop();
      setState(() => live = false);
      return;
    }
    if (!await Permission.microphone.request().isGranted) {
      _snack('Autorise le micro pour utiliser Voxora.');
      return;
    }
    _apply();
    if (_start() == 0) {
      _snack('Impossible d’ouvrir le micro ou la sortie audio.');
      return;
    }
    det.clear();
    cor.clear();
    _timer = Timer.periodic(const Duration(milliseconds: 40), (_) {
      det.add(_det());
      cor.add(_cor());
      if (det.length > 200) {
        det.removeAt(0);
        cor.removeAt(0);
      }
      setState(() {});
    });
    setState(() => live = true);
  }

  Future<void> _toggleRec() async {
    if (!recording) {
      _rec(1);
      setState(() => recording = true);
      return;
    }
    _rec(0);
    setState(() => recording = false);
    final dir = await getApplicationDocumentsDirectory();
    final path = '${dir.path}/voxora_${DateTime.now().millisecondsSinceEpoch}.wav';
    final p = path.toNativeUtf8();
    final ok = _save(p);
    malloc.free(p);
    _snack(ok == 1 ? 'Enregistré : $path' : 'L’enregistrement a échoué.');
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (live) _stop();
    super.dispose();
  }

  String get _note {
    final m = cor.isNotEmpty && cor.last > 0 ? cor.last : (det.isNotEmpty ? det.last : 0);
    return m > 0 ? keys[m.round() % 12] : '–';
  }

  Widget _slider(String label, double v, double mn, double mx, String unit,
      ValueChanged<double> on) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
        Text(label),
        Text('${v.round()}$unit', style: const TextStyle(color: Colors.white60)),
      ]),
      Slider(
        value: v,
        min: mn,
        max: mx,
        divisions: (mx - mn).round(),
        onChanged: (x) {
          setState(() => on(x));
          _apply();
        },
      ),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(16), children: [
          const Text('Voxora Live',
              style: TextStyle(fontSize: 32, fontWeight: FontWeight.w800)),
          const Text('Auto-Tune en direct', style: TextStyle(color: Colors.white60)),
          const SizedBox(height: 12),
          Container(
            height: 230,
            decoration: BoxDecoration(
              color: const Color(0xFF171E33),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Stack(children: [
              Positioned.fill(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(18),
                  child: CustomPaint(painter: PitchPainter(det, cor, mask, key)),
                ),
              ),
              Positioned(
                right: 16,
                top: 8,
                child: Text(_note,
                    style: const TextStyle(
                        fontSize: 44, fontWeight: FontWeight.w800, color: Color(0xFFFFB347))),
              ),
            ]),
          ),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
              child: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                onPressed: _toggle,
                child: Text(live ? 'Arrêter' : 'Démarrer le direct'),
              ),
            ),
            const SizedBox(width: 10),
            OutlinedButton(
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 56)),
              onPressed: live ? _toggleRec : null,
              child: Text(recording ? 'Stop et sauvegarder' : 'Enregistrer'),
            ),
          ]),
          const SizedBox(height: 10),
          const Text(
            'Branche un casque filaire : sans casque, le micro capte le haut-parleur (larsen). '
            'Le Bluetooth ajoute beaucoup de retard.',
            style: TextStyle(color: Colors.white54, fontSize: 13),
          ),
          const SizedBox(height: 14),
          Wrap(spacing: 8, children: [
            for (final e in presets.entries)
              ActionChip(
                label: Text(e.key),
                onPressed: () {
                  setState(() {
                    amt = e.value[0];
                    spd = e.value[1];
                    bass = e.value[2];
                    pres = e.value[3];
                    air = e.value[4];
                    comp = e.value[5];
                    rev = e.value[6];
                    echo = e.value[7];
                  });
                  _apply();
                },
              ),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: DropdownButtonFormField<int>(
                value: key,
                decoration: const InputDecoration(labelText: 'Tonalité'),
                items: [
                  for (int i = 0; i < 12; i++) DropdownMenuItem(value: i, child: Text(keys[i]))
                ],
                onChanged: (v) {
                  setState(() => key = v!);
                  _apply();
                },
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 2,
              child: DropdownButtonFormField<String>(
                value: scale,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Gamme'),
                items: [for (final s in scales.keys) DropdownMenuItem(value: s, child: Text(s))],
                onChanged: (v) {
                  setState(() => scale = v!);
                  _apply();
                },
              ),
            ),
          ]),
          const SizedBox(height: 8),
          _slider('Correction', amt, 0, 100, '%', (v) => amt = v),
          _slider('Vitesse (100 = effet robot)', spd, 0, 100, '%', (v) => spd = v),
          _slider('Transposition', trn, -12, 12, ' ½ ton', (v) => trn = v),
          const SizedBox(height: 6),
          ExpansionTile(
            title: const Text('Effets de studio'),
            initiallyExpanded: true,
            tilePadding: EdgeInsets.zero,
            children: [
              _slider('Graves', bass, -12, 12, ' dB', (v) => bass = v),
              _slider('Présence', pres, -12, 12, ' dB', (v) => pres = v),
              _slider('Air', air, -12, 12, ' dB', (v) => air = v),
              _slider('Compresseur', comp, 0, 100, '%', (v) => comp = v),
              _slider('Réverbération', rev, 0, 100, '%', (v) => rev = v),
              _slider('Écho', echo, 0, 100, '%', (v) => echo = v),
            ],
          ),
        ]),
      ),
    );
  }
}

class PitchPainter extends CustomPainter {
  PitchPainter(this.det, this.cor, this.mask, this.key);
  final List<double> det, cor;
  final int mask, key;

  @override
  void paint(Canvas c, Size s) {
    final voiced = det.where((e) => e > 0);
    double lo = 57, hi = 81;
    if (voiced.isNotEmpty) {
      final ce = (voiced.reduce(math.min) + voiced.reduce(math.max)) / 2;
      lo = ce - 12;
      hi = ce + 12;
    }
    double y(double m) => s.height - (m - lo) / (hi - lo) * s.height;
    final grid = Paint()..color = Colors.white12;
    for (int n = lo.ceil(); n <= hi.floor(); n++) {
      final rel = ((n - key) % 12 + 12) % 12;
      if (((mask >> rel) & 1) == 1) {
        grid.strokeWidth = rel == 0 ? 2 : 1;
        c.drawLine(Offset(0, y(n.toDouble())), Offset(s.width, y(n.toDouble())), grid);
      }
    }
    void line(List<double> a, Color col, double w) {
      final p = Paint()
        ..color = col
        ..strokeWidth = w
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round;
      Path? path;
      for (int i = 0; i < a.length; i++) {
        final x = i / 199 * s.width;
        if (a[i] <= 0) {
          if (path != null) c.drawPath(path, p);
          path = null;
          continue;
        }
        if (path == null) {
          path = Path()..moveTo(x, y(a[i]));
        } else {
          path.lineTo(x, y(a[i]));
        }
      }
      if (path != null) c.drawPath(path, p);
    }

    line(det, const Color(0xFF5CD0E6), 1.5);
    line(cor, const Color(0xFFFFB347), 3);
  }

  @override
  bool shouldRepaint(PitchPainter old) => true;
}

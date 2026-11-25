import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../models/studio_models.dart';
import '../theme/studio_theme.dart';

class StudioSlider extends StatelessWidget {
  const StudioSlider({
    super.key,
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.unit,
    required this.defaultValue,
    required this.onChanged,
    this.decimals = 0,
    this.useCyan = false,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final String unit;
  final double defaultValue;
  final ValueChanged<double> onChanged;
  final int decimals;
  final bool useCyan;

  @override
  Widget build(BuildContext context) {
    final sc = Theme.of(context).extension<StudioColors>()!;
    final accent = useCyan ? sc.cyan : sc.amber;
    final clamped = value.clamp(min, max).toDouble();
    final formatted = decimals > 0
        ? clamped.toStringAsFixed(decimals)
        : '${clamped > 0 && min < 0 ? '+' : ''}${clamped.round()}';

    return GestureDetector(
      onDoubleTap: () => onChanged(defaultValue),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: sc.textPrimary,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '$formatted$unit',
                maxLines: 1,
                style: TextStyle(
                  fontSize: 12,
                  fontFamily: 'monospace',
                  color: sc.textSecondary,
                ),
              ),
            ],
          ),
          SliderTheme(
            data: SliderTheme.of(context).copyWith(
              activeTrackColor: accent,
              inactiveTrackColor: sc.border,
              thumbColor: accent,
              overlayColor: accent.withAlpha(36),
              trackHeight: 3,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
            ),
            child: Slider(
              value: clamped,
              min: min,
              max: max,
              onChanged: onChanged,
            ),
          ),
        ],
      ),
    );
  }
}

class LevelMeterBar extends StatelessWidget {
  const LevelMeterBar({
    super.key,
    required this.label,
    required this.normalized,
    required this.color,
    this.valueLabel,
  });

  final String label;
  final double normalized;
  final Color color;
  final String? valueLabel;

  @override
  Widget build(BuildContext context) {
    final sc = Theme.of(context).extension<StudioColors>()!;
    final v = normalized.clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              label,
              maxLines: 1,
              style: TextStyle(fontSize: 11, color: sc.textSecondary),
            ),
            if (valueLabel != null)
              Text(
                valueLabel!,
                maxLines: 1,
                style: TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: sc.textSecondary,
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(3),
          child: SizedBox(
            height: 6,
            child: LinearProgressIndicator(
              value: v,
              backgroundColor: sc.surfaceElevated,
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
        ),
      ],
    );
  }
}

class PitchPainter extends CustomPainter {
  PitchPainter({
    required this.det,
    required this.cor,
    required this.mask,
    required this.keyIndex,
    required this.colors,
  });

  final List<double> det;
  final List<double> cor;
  final int mask;
  final int keyIndex;
  final StudioColors colors;

  @override
  void paint(Canvas canvas, Size size) {
    final voiced = det.where((e) => e > 0);
    double lo = 54;
    double hi = 78;
    if (voiced.isNotEmpty) {
      final center = (voiced.reduce(math.min) + voiced.reduce(math.max)) * 0.5;
      lo = center - 12;
      hi = center + 12;
    }

    double yForMidi(double m) =>
        size.height - ((m - lo) / (hi - lo)) * size.height;

    final gridPaint = Paint();
    for (int n = lo.ceil(); n <= hi.floor(); n++) {
      final rel = ((n - keyIndex) % 12 + 12) % 12;
      if (((mask >> rel) & 1) == 1) {
        final isRoot = rel == 0;
        gridPaint.color =
            isRoot ? colors.amber.withAlpha(75) : colors.border;
        gridPaint.strokeWidth = isRoot ? 1.5 : 1.0;
        final y = yForMidi(n.toDouble());
        canvas.drawLine(Offset(0, y), Offset(size.width, y), gridPaint);
      }
    }

    void drawCurve(List<double> arr, Color color, double strokeWidth) {
      if (arr.length < 2) return;
      final p = Paint()
        ..color = color
        ..strokeWidth = strokeWidth
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round;
      Path? path;
      for (int i = 0; i < arr.length; i++) {
        final x = (i / (arr.length - 1)) * size.width;
        if (arr[i] <= 0) {
          if (path != null) canvas.drawPath(path, p);
          path = null;
          continue;
        }
        final y = yForMidi(arr[i]);
        if (path == null) {
          path = Path()..moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      }
      if (path != null) canvas.drawPath(path, p);
    }

    drawCurve(det, colors.cyan, 1.8);
    drawCurve(cor, colors.amber, 2.8);
  }

  @override
  bool shouldRepaint(covariant PitchPainter oldDelegate) => true;
}

class WaveformPainter extends CustomPainter {
  WaveformPainter({
    required this.peaks,
    required this.color,
    required this.progress,
    required this.cursorColor,
  });

  final List<double> peaks;
  final Color color;
  final double progress;
  final Color cursorColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (peaks.isEmpty) return;
    final midY = size.height * 0.5;
    final barW = size.width / peaks.length;
    final paintActive = Paint()
      ..color = color
      ..strokeWidth = math.max(1.2, barW * 0.65)
      ..strokeCap = StrokeCap.round;
    final paintDim = Paint()
      ..color = color.withAlpha(90)
      ..strokeWidth = math.max(1.2, barW * 0.65)
      ..strokeCap = StrokeCap.round;

    for (int i = 0; i < peaks.length; i++) {
      final x = (i + 0.5) * barW;
      final h = math.max(2.0, peaks[i].clamp(0.0, 1.0) * size.height * 0.86);
      final isPassed = (i / peaks.length) <= progress;
      canvas.drawLine(
        Offset(x, midY - h * 0.5),
        Offset(x, midY + h * 0.5),
        isPassed ? paintActive : paintDim,
      );
    }

    if (progress >= 0 && progress <= 1) {
      final px = progress * size.width;
      canvas.drawLine(
        Offset(px, 0),
        Offset(px, size.height),
        Paint()
          ..color = cursorColor
          ..strokeWidth = 1.6,
      );
    }
  }

  @override
  bool shouldRepaint(covariant WaveformPainter oldDelegate) =>
      oldDelegate.progress != progress ||
      oldDelegate.peaks != peaks ||
      oldDelegate.color != color;
}

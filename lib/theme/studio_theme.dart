import 'package:flutter/material.dart';

class StudioColors extends ThemeExtension<StudioColors> {
  const StudioColors({
    required this.canvas,
    required this.surface,
    required this.surfaceElevated,
    required this.border,
    required this.textPrimary,
    required this.textSecondary,
    required this.amber,
    required this.cyan,
    required this.danger,
  });

  final Color canvas;
  final Color surface;
  final Color surfaceElevated;
  final Color border;
  final Color textPrimary;
  final Color textSecondary;
  final Color amber;
  final Color cyan;
  final Color danger;

  static const dark = StudioColors(
    canvas: Color(0xFF0B0F1A),
    surface: Color(0xFF121829),
    surfaceElevated: Color(0xFF192238),
    border: Color(0x1AFFFFFF),
    textPrimary: Color(0xFFF1F5F9),
    textSecondary: Color(0xFF94A3B8),
    amber: Color(0xFFFFB347),
    cyan: Color(0xFF5CD0E6),
    danger: Color(0xFFEF4444),
  );

  static const light = StudioColors(
    canvas: Color(0xFFF4F6FA),
    surface: Color(0xFFFFFFFF),
    surfaceElevated: Color(0xFFE9EEF5),
    border: Color(0x1F0F172A),
    textPrimary: Color(0xFF0F172A),
    textSecondary: Color(0xFF475569),
    amber: Color(0xFFD97706),
    cyan: Color(0xFF0284C7),
    danger: Color(0xFFDC2626),
  );

  @override
  StudioColors copyWith({
    Color? canvas,
    Color? surface,
    Color? surfaceElevated,
    Color? border,
    Color? textPrimary,
    Color? textSecondary,
    Color? amber,
    Color? cyan,
    Color? danger,
  }) {
    return StudioColors(
      canvas: canvas ?? this.canvas,
      surface: surface ?? this.surface,
      surfaceElevated: surfaceElevated ?? this.surfaceElevated,
      border: border ?? this.border,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      amber: amber ?? this.amber,
      cyan: cyan ?? this.cyan,
      danger: danger ?? this.danger,
    );
  }

  @override
  StudioColors lerp(ThemeExtension<StudioColors>? other, double t) {
    if (other is! StudioColors) return this;
    return StudioColors(
      canvas: Color.lerp(canvas, other.canvas, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceElevated: Color.lerp(surfaceElevated, other.surfaceElevated, t)!,
      border: Color.lerp(border, other.border, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      amber: Color.lerp(amber, other.amber, t)!,
      cyan: Color.lerp(cyan, other.cyan, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
    );
  }
}

ThemeData buildStudioTheme(Brightness brightness) {
  final isDark = brightness == Brightness.dark;
  final sc = isDark ? StudioColors.dark : StudioColors.light;

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: sc.canvas,
    colorScheme: ColorScheme(
      brightness: brightness,
      primary: sc.amber,
      onPrimary: isDark ? const Color(0xFF0B0F1A) : Colors.white,
      secondary: sc.cyan,
      onSecondary: isDark ? const Color(0xFF0B0F1A) : Colors.white,
      error: sc.danger,
      onError: Colors.white,
      surface: sc.surface,
      onSurface: sc.textPrimary,
    ),
    cardColor: sc.surface,
    dividerColor: sc.border,
    extensions: [sc],
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: sc.surfaceElevated,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: sc.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: sc.border),
      ),
    ),
  );
}

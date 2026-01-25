import 'package:flutter/material.dart';
import '../colors.dart';        // ✅ correct
import 'sf_theme.dart';         // ✅ same folder


InputDecorationTheme sfInputTheme() {
  return InputDecorationTheme(
    filled: true,
    fillColor: Colors.white,

    contentPadding: SFTheme.inputPadding,

    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(SFTheme.radiusMd),
      borderSide: const BorderSide(color: SFColors.cardBorder),
    ),

    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(SFTheme.radiusMd),
      borderSide: const BorderSide(color: SFColors.cardBorder),
    ),

    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(SFTheme.radiusMd),
      borderSide: const BorderSide(
        color: SFColors.primaryBlue,
        width: 1.5,
      ),
    ),

    hintStyle: const TextStyle(
      color: SFColors.textMuted,
    ),

    labelStyle: const TextStyle(
      color: SFColors.textMuted,
    ),
  );
}

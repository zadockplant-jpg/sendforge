import 'package:flutter/material.dart';
import '../core/app_state.dart';
import 'colors.dart';
import 'screens/home_screen.dart';


class SendForgeApp extends StatefulWidget {
  const SendForgeApp({super.key});

  @override
  State<SendForgeApp> createState() => _SendForgeAppState();
}

class _SendForgeAppState extends State<SendForgeApp> {
  final AppState appState = AppState();

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: appState,
      builder: (context, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: 'SendForge',
          theme: ThemeData(
            useMaterial3: true,
            colorSchemeSeed: SFColors.primaryBlue,
            scaffoldBackgroundColor: SFColors.background,
            appBarTheme: const AppBarTheme(
              backgroundColor: SFColors.primaryBlue,
              foregroundColor: Colors.white,
            ),
            inputDecorationTheme: InputDecorationTheme(
              filled: true,
              fillColor: Colors.white,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Colors.black12),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
                borderSide: const BorderSide(color: Colors.black12),
              ),
            ),
          ),
          home: HomeScreen(appState: appState),
        );
      },
    );
  }
}

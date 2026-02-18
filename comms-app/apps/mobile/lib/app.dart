import 'package:flutter/material.dart';
import '../core/app_state.dart';
import 'ui/colors.dart';
import 'ui/screens/home_screen.dart';
import 'ui/theme/sf_input_theme.dart';

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

            // 🔗 GLOBAL INPUT STYLING (this is the hook)
            inputDecorationTheme: sfInputTheme(),
          ),

          home: HomeScreen(
  appState: appState,
  auth: authState,
)

        );
      },
    );
  }
}

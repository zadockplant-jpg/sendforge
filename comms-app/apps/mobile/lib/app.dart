import 'package:flutter/material.dart';
import 'core/app_state.dart';
import 'core/auth_state.dart';
import 'services/auth_service.dart';
import 'ui/screens/home_screen.dart';
import 'ui/screens/login_screen.dart';
import 'ui/screens/register_screen.dart';
import 'ui/colors.dart';
import 'ui/theme/sf_input_theme.dart';

class SendForgeApp extends StatefulWidget {
  final AuthState authState;

  const SendForgeApp({super.key, required this.authState});

  @override
  State<SendForgeApp> createState() => _SendForgeAppState();
}

class _SendForgeAppState extends State<SendForgeApp> {
  final AppState appState = AppState();

  @override
  Widget build(BuildContext context) {
    final authService = AuthService(
      "https://comms-app-1wo0.onrender.com",
    );

    return AnimatedBuilder(
      animation: widget.authState,
      builder: (context, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: 'SendForge',
          theme: ThemeData(
            useMaterial3: true,
            colorSchemeSeed: SFColors.primaryBlue,
            scaffoldBackgroundColor: SFColors.background,
            inputDecorationTheme: sfInputTheme(),
          ),
          home: widget.authState.isLoggedIn
              ? HomeScreen(
                  appState: appState,
                  auth: widget.authState,
                )
              : LoginScreen(
                  auth: widget.authState,
                  service: authService,
                ),
          routes: {
            '/register': (_) => RegisterScreen(
                  auth: widget.authState,
                  service: authService,
                ),
          },
        );
      },
    );
  }
}
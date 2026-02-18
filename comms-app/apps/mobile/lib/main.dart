import 'package:flutter/material.dart';

import 'app.dart'; // your real home app
import 'core/auth_state.dart';
import 'services/auth_service.dart';
import 'ui/screens/login_screen.dart';


void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final authState = AuthState();
  await authState.load();

  runApp(SendForgeRoot(authState: authState));
}

class SendForgeRoot extends StatelessWidget {
  final AuthState authState;
  const SendForgeRoot({super.key, required this.authState});

  @override
  Widget build(BuildContext context) {
    final authService = AuthService(
      const String.fromEnvironment(
        'API_BASE_URL',
        defaultValue: 'https://YOUR_BACKEND_URL',
      ),
    );

    return AnimatedBuilder(
      animation: authState,
      builder: (context, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          home: authState.isLoggedIn
              ? const SendForgeApp() // ✅ REAL HOME
              : LoginScreen(
                  auth: authState,
                  service: authService,
                ),
        );
      },
    );
  }
}

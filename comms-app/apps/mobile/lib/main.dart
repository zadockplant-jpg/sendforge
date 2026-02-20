import 'package:flutter/material.dart';
import 'core/auth_state.dart';
import 'app.dart';

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
    return AnimatedBuilder(
      animation: authState,
      builder: (context, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          home: authState.isInitialized
              ? SendForgeApp(authState: authState)
              : const Scaffold(
                  body: Center(child: CircularProgressIndicator()),
                ),
        );
      },
    );
  }
}

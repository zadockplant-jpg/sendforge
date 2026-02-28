import 'package:flutter/material.dart';
import '../../services/auth_service.dart';
import '../../core/auth_state.dart';
import '../colors.dart';

class RegisterScreen extends StatefulWidget {
  final AuthState auth; // signature unchanged
  final AuthService service;

  const RegisterScreen({
    super.key,
    required this.auth,
    required this.service,
  });

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final emailCtrl = TextEditingController();
  final passCtrl = TextEditingController();

  bool loading = false;
  String? error;
  bool success = false;

  Future<void> submit() async {
    setState(() {
      loading = true;
      error = null;
      success = false;
    });

    try {
      await widget.service.register(
        emailCtrl.text.trim(),
        passCtrl.text.trim(),
      );

      if (!mounted) return;
      setState(() => success = true);
    } catch (e) {
      if (!mounted) return;
      setState(() => error = "Registration failed");
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: SFColors.background,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(
                  Icons.rocket_launch,
                  size: 64,
                  color: SFColors.primaryBlue,
                ),
                const SizedBox(height: 16),
                const Text(
                  "Create Account",
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                const SizedBox(height: 32),

                TextField(
                  controller: emailCtrl,
                  decoration: const InputDecoration(labelText: "Email"),
                  textInputAction: TextInputAction.next,
                ),
                const SizedBox(height: 16),

                TextField(
                  controller: passCtrl,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: "Password (8+ chars)"),
                  textInputAction: TextInputAction.done,
                  // ✅ Enter submits register
                  onSubmitted: (_) => submit(),
                ),
                const SizedBox(height: 24),

                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.red),
                    ),
                  ),

                if (success)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      "Account created ✅\nCheck your email to verify, then return and log in.",
                      textAlign: TextAlign.center,
                      style: TextStyle(color: SFColors.textPrimary.withOpacity(0.9)),
                    ),
                  ),

                ElevatedButton(
                  onPressed: loading ? null : submit,
                  child: loading
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text("Create Account"),
                ),

                const SizedBox(height: 16),

                TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text("Already have an account? Login"),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
import 'package:flutter/material.dart';
import '../../core/auth_state.dart';
import '../../services/auth_service.dart';
import '../colors.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  final AuthState auth;
  final AuthService service;

  const LoginScreen({
    super.key,
    required this.auth,
    required this.service,
  });

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final emailCtrl = TextEditingController();
  final passCtrl = TextEditingController();

  bool loading = false;
  String? error;

  Future<void> submit() async {
    setState(() {
      loading = true;
      error = null;
    });

    try {
      final token = await widget.service.login(
        emailCtrl.text.trim(),
        passCtrl.text.trim(),
      );

      if (token == null || token.isEmpty) {
        throw Exception("Invalid token");
      }

      await widget.auth.login(token);
    } catch (e) {
      setState(() => error = 'Login failed');
    } finally {
      if (mounted) {
        setState(() => loading = false);
      }
    }
  }

  Future<void> demoLogin() async {
    await widget.auth.login("demo-token");
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            colors: [
              SFColors.headerBlueDark,
              SFColors.headerBlueLight,
            ],
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
          ),
        ),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Card(
              elevation: 12,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
              ),
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(
                      Icons.send,
                      size: 48,
                      color: SFColors.primaryBlue,
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      "SendForge",
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 24),

                    TextField(
                      controller: emailCtrl,
                      decoration:
                          const InputDecoration(labelText: 'Email'),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: passCtrl,
                      obscureText: true,
                      decoration:
                          const InputDecoration(labelText: 'Password'),
                    ),
                    const SizedBox(height: 20),

                    if (error != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Text(
                          error!,
                          style: const TextStyle(color: Colors.red),
                        ),
                      ),

                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
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
                            : const Text('Login'),
                      ),
                    ),

                    const SizedBox(height: 12),

                    TextButton(
                      onPressed: () {
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => RegisterScreen(
                              auth: widget.auth,
                              service: widget.service,
                            ),
                          ),
                        );
                      },
                      child: const Text("Create Account"),
                    ),

                    const Divider(height: 28),

                    TextButton(
                      onPressed: demoLogin,
                      child: const Text("Continue as Demo"),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

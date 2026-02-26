import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../colors.dart';

class RegisterScreen extends StatefulWidget {
  final AppState appState;
  const RegisterScreen({super.key, required this.appState});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool busy = false;
  String? err;

  Future<void> _submit() async {
    setState(() {
      busy = true;
      err = null;
    });

    try {
      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final auth = AuthService(api);

      await auth.register(email: _email.text, password: _password.text);

      await widget.appState.loadContacts();
      await widget.appState.loadGroups();

      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Register"),
        backgroundColor: SFColors.primaryBlue,
        foregroundColor: Colors.white,
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: AutofillGroup(
            child: Column(
              children: [
                if (err != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(err!, style: const TextStyle(color: Colors.red)),
                  ),

                TextField(
                  controller: _email,
                  autofillHints: const [AutofillHints.email],
                  keyboardType: TextInputType.emailAddress,
                  decoration: const InputDecoration(labelText: "Email"),
                  textInputAction: TextInputAction.next,
                ),

                const SizedBox(height: 12),

                TextField(
                  controller: _password,
                  obscureText: true,
                  autofillHints: const [AutofillHints.newPassword],
                  decoration: const InputDecoration(labelText: "Password"),
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => busy ? null : _submit(),
                ),

                const SizedBox(height: 20),

                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: busy ? null : _submit,
                    child: Text(busy ? "Creating..." : "Create account",
                        style: const TextStyle(fontWeight: FontWeight.w900)),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
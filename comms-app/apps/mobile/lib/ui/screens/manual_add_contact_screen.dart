import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/contact.dart';
import '../../services/api_client.dart';
import '../../services/contact_import_service.dart';

class ManualAddContactScreen extends StatefulWidget {
  final AppState appState;
  const ManualAddContactScreen({super.key, required this.appState});

  @override
  State<ManualAddContactScreen> createState() => _ManualAddContactScreenState();
}

class _ManualAddContactScreenState extends State<ManualAddContactScreen> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();

  bool busy = false;
  String? status;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => status = null);
    if (!_formKey.currentState!.validate()) return;

    setState(() => busy = true);
    try {
      final c = Contact(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        name: _name.text.trim(),
        phone: _phone.text.trim().isEmpty ? null : _phone.text.trim(),
        email: _email.text.trim().isEmpty ? null : _email.text.trim(),
      );

      final api = ApiClient(baseUrl: widget.appState.baseUrl);
      final service = ContactImportService(api);

      await service.importContacts(method: 'manual', contacts: [c]);

      widget.appState.contacts.add(c);

      if (!mounted) return;
      setState(() => status = 'Saved ✅');
      Navigator.pop(context);
    } catch (e) {
      if (!mounted) return;
      setState(() => status = 'Failed: $e');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add Contact')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextFormField(
                controller: _name,
                decoration: const InputDecoration(labelText: 'Name'),
                validator: (v) => (v == null || v.trim().isEmpty) ? 'Name required' : null,
              ),
              const SizedBox(height: 10),
              TextFormField(
                controller: _phone,
                decoration: const InputDecoration(labelText: 'Phone (optional)'),
              ),
              const SizedBox(height: 10),
              TextFormField(
                controller: _email,
                decoration: const InputDecoration(labelText: 'Email (optional)'),
              ),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  onPressed: busy ? null : _save,
                  style: FilledButton.styleFrom(
                    alignment: Alignment.centerLeft,
                    padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 14),
                  ),
                  child: Text(
                    busy ? 'Saving…' : 'Save Contact',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
              ),
              if (status != null) ...[
                const SizedBox(height: 10),
                Text(status!),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

# State backend of personal-stage. tf.sh adds key = "<env>/<stack>.tfstate".
#
# PLACEHOLDERS: every REPLACE_ME value below is a placeholder, not a real
# resource. Fill them from the outputs of bootstrap/ (see ../../README.md).
# tf.sh refuses to run while a REPLACE_ME remains in this directory.

bucket     = "comparative-tfstate-REPLACE_ME_ACCOUNT_ID-us-east-1"
region     = "us-east-1"
kms_key_id = "REPLACE_ME_STATE_KMS_KEY_ARN"

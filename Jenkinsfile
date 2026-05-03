podTemplate(yaml: '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: node
      image: node:22-alpine
      command:
        - cat
      tty: true
    - name: docker
      image: docker:29-cli
      command:
        - cat
      tty: true
      volumeMounts:
        - name: docker-sock
          mountPath: /var/run/docker.sock
    - name: jnlp
      image: alskung/biddinggo-jenkins-agent:latest
      volumeMounts:
        - name: docker-sock
          mountPath: /var/run/docker.sock
  volumes:
    - name: docker-sock
      hostPath:
        path: /var/run/docker.sock
        type: Socket
''') {
  node(POD_LABEL) {
    properties([
      pipelineTriggers([
        githubPush()
      ])
    ])

    def dockerImage = 'alskung/biddinggo-frontend'
    def dockerhubCredentialsId = 'dockerhub-access'
    def githubCredentialsId = 'github-token-biddinggo'
    def k8sDeploymentManifest = 'k8s/frontend-deployment.yaml'
    def viteApiBaseUrl = '/api/v1'
    def imageTag = ''
    def targetBranch = ''
    def skipCi = false
    def buildFailed = false

    def notifyDiscord = { String status ->
      def resolvedImage = imageTag ? "${dockerImage}:${imageTag}" : "${dockerImage}:unknown"
      def resolvedBranch = targetBranch ?: (env.BRANCH_NAME ?: 'feat/frontend-deploy')

      withCredentials([string(credentialsId: 'discord-webhook-url', variable: 'DISCORD_WEBHOOK_URL')]) {
        sh """
          set +x
          curl -H "Content-Type: application/json" \\
            -d "{\\"content\\":\\"[Jenkins] Frontend CI ${status} - Job: ${env.JOB_NAME} #${env.BUILD_NUMBER} - Image: ${resolvedImage} - Branch: ${resolvedBranch}\\"}" \\
            "\$DISCORD_WEBHOOK_URL"
        """
      }
    }

    try {
      stage('Checkout') {
        checkout scm
        def gitCommitShort = sh(script: 'git rev-parse --short=12 HEAD', returnStdout: true).trim()
        imageTag = "${env.BUILD_NUMBER}-${gitCommitShort}"
        targetBranch = env.BRANCH_NAME ?: (env.GIT_BRANCH ?: 'origin/feat/frontend-deploy').replaceFirst('^origin/', '')
        currentBuild.displayName = "#${env.BUILD_NUMBER} ${imageTag}"
        skipCi = sh(script: "git log -1 --pretty=%B | grep -qi '\\[skip ci\\]'", returnStatus: true) == 0

        if (skipCi) {
          currentBuild.displayName = "#${env.BUILD_NUMBER} skipped"
          echo 'Skipping manifest-only CI commit.'
        }
      }

      if (!skipCi) {
        stage('Install') {
          container('node') {
            sh 'npm ci'
          }
        }

        stage('Build') {
          container('node') {
            sh 'npm run build'
          }
        }

        stage('Docker Build and Push') {
          container('docker') {
            withCredentials([usernamePassword(
              credentialsId: dockerhubCredentialsId,
              usernameVariable: 'DOCKER_USERNAME',
              passwordVariable: 'DOCKER_PASSWORD'
            )]) {
              sh """
                set -eu
                echo "\$DOCKER_PASSWORD" | docker login -u "\$DOCKER_USERNAME" --password-stdin
                docker build --build-arg VITE_API_BASE_URL=${viteApiBaseUrl} -t ${dockerImage}:${imageTag} -t ${dockerImage}:latest .
                docker push ${dockerImage}:${imageTag}
                docker push ${dockerImage}:latest
                docker logout
              """
            }
          }
        }

        stage('Update Kubernetes Manifest') {
          withCredentials([usernamePassword(
            credentialsId: githubCredentialsId,
            usernameVariable: 'GIT_USERNAME',
            passwordVariable: 'GIT_PASSWORD'
          )]) {
            sh """
              set -eu
              sed -i "s#image: ${dockerImage}:.*#image: ${dockerImage}:${imageTag}#" "${k8sDeploymentManifest}"
              git config user.name "jenkins"
              git config user.email "jenkins@local"
              git add "${k8sDeploymentManifest}"
              if git diff --cached --quiet; then
                echo "No manifest change to commit."
                exit 0
              fi
              git commit -m "ci: deploy frontend ${imageTag} [skip ci]"
              git push "https://\$GIT_USERNAME:\$GIT_PASSWORD@github.com/alskung1101/be25-3rd-biddingmate-biddinggo.git" HEAD:${targetBranch}
            """
          }
        }
      }

      echo "Frontend CI pipeline completed. Image: ${dockerImage}:${imageTag}"
    } catch (err) {
      buildFailed = true
      currentBuild.result = 'FAILURE'
      echo "Frontend CI pipeline failed: ${err}"
      throw err
    } finally {
      if (skipCi) {
        echo 'Discord notification skipped for [skip ci] commit.'
      } else {
        notifyDiscord(buildFailed ? 'FAILED' : 'SUCCESS')
      }
    }
  }
}
